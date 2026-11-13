# Implementation plan: User & Org management refactor, Phase 6 (cross-cutting: PII encryption, agreements, RBAC)

**Date:** 2026-09-30
**Branch:** `refactor/user-org-management` (same branch as Phases 1–4)
**Status:** Plan only. Nothing here is implemented. Decisions marked **⚠ REVIEW** need your call before the first release of that track.
**Depends on:** Phases 1–5. See the banner below: the old header assumed `app_user`, `organisation` + `organisation_member` and the old Phase 4 APIs. The three tracks (6a PII encryption, 6b agreements, 6c RBAC; numbered 5a–5c below) are independent; recommended order **6c → 6b → 6a**.
**Companions:** `contact-table-phase-1.md` (§0.3, §9), `users-phase-2.md`, `apis-phase-5.md`, `user-org-refactor-decisions.md`.

> Delete this file in the commit that completes Phase 6 (repo convention for `docs/plans/`).

## ▶ Update 2026-10-05: renumbered and re-based on the new target model

This was Phase 5; the sections are still numbered 5a–5c. Read the old names through the table in `apis-phase-5.md` (banner): `app_user` → `users`, `organisation` → `organisations`, `organisation_member` → `users.org_id`, `'NetworkFacilitator'` / `'Aggregator'` → `'network_facilitator'` / `'aggregator'`.

**Impacts per track:**

- **5a (PII encryption):** unchanged in substance. `contact` is still the only PII table. Phase 4 moves `alternate_phone` onto `users`, and Phase 3 keeps per-coordinator `legacy_org_details` (may include addresses) in `users.profile`: both are PII and must join the encryption / masking scope.
- **5b (agreements):** builds on `consent_record`, which Phase 4 already gives typed `user_id` / `org_id` links, `valid_till` (G9) and same-transaction writes. "Link an agreement to an org or user" maps onto those two FKs. Re-consent enforcement on `valid_till` is decided here.
- **5c (RBAC):** permission sets map from `users.user_type` and the org's `org_type`; the enforcement point is the Phase 5 `resolveActor`.
- **Safety rules:** the expand → contract paragraph below is superseded by stop-the-world releases (G11) where a release renames or drops; additive releases may still roll out live.

**Design doc:** contact is the default PII object, **encrypted and masked by default** (configuration is a doc ToDo). Agreements (T&C, Privacy, Consent) are configurable per `user_type` / `org_type`, with APIs to create/configure an agreement and link it to an org or user. RBAC is permission sets by feature (e.g. Bulk Upload of Profiles, Registration Links) with a default mapping from user type to permission set. The doc's "don't consider" items (users under 18, profile lifecycle, actions) stay out of scope.

Every track follows the same safety rules as Phases 1–2: idempotent migrations that double as the pre-deploy script, `pg_advisory_xact_lock` + `lock_timeout 5s` + `SET LOCAL ROLE` to the table owner (decisions D1, D3, B2); each release works against the next release's schema; expand → switch reads → switch writes → contract; the destructive step is its own release with a snapshot first (decisions D21).

---

## 5a. PII encryption at rest for `contact`

### 5a.1 Today

| Fact                                                                                                                                                                            | Evidence                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contact.email`, `phone`, `name` are plaintext columns.                                                                                                                         | `packages/db-schema/src/schema.ts:193-212`; `0025_contact.sql:119-130`                                                                               |
| Uniqueness is on plaintext: `contact_email_unique`, `contact_phone_unique`.                                                                                                     | `0025_contact.sql:135-136`                                                                                                                           |
| `contact.id = sha256(lower(email):phone)`, **unsalted**, so it can be brute-forced back to email+phone. It is enforced in the DB by `CHECK (id = contact_id_of(email, phone))`. | `shared-primitives/src/contact` `contactId()` (`:62-68`, `createHash('sha256')`); `0025_contact.sql:87,130`                                          |
| Every FK to `contact` is `ON UPDATE CASCADE` so ids can be re-keyed.                                                                                                            | `0025` (aggregators, aggregator_orgs), `0027_app_user.sql` (`app_user.contact_id`); `schema.ts:228-230`                                              |
| Plaintext lookups by value: 4 places.                                                                                                                                           | `aggregator-store/postgres.ts:116,127` (`findByContactPhone/Email`); `aggregator-org-store/postgres.ts:86,99` (`findByOwnerEmail/Phone`)             |
| Plaintext reads (joins that compose the Beckn `contact`):                                                                                                                       | `aggregator-store/postgres.ts:341`; `aggregator-org-store/postgres.ts:137,217`; `services/owner-name-backfill.ts`; `scripts/sql/contact-verify*.sql` |
| The SQL helpers that computed ids from plaintext (`contact_link`, `contact_move`, legacy triggers) are already gone; `contact_gc` stays and is id-only.                         | `0026_contact_drop_legacy.sql:65-76`                                                                                                                 |
| Logs redact `email`/`phone` keys up to two levels deep. `name` is not redacted.                                                                                                 | `apps/api/src/logger.ts:13-33`                                                                                                                       |
| The web already recognises Signals-style masks (`"M***"`, `"+91-XX-XXXX-X123"`).                                                                                                | `apps/web/src/lib/geo/pii-mask.ts` (`apps/web/CLAUDE.md` "geo layer")                                                                                |
| Secrets are env-only today (e.g. `APPROVAL_TOKEN_SECRET`, ≥32 chars, cached). There is no KMS integration.                                                                      | `services/token-common.ts:24-32`                                                                                                                     |
| Keycloak holds its own plaintext copy (username = email, `phoneNumber` attribute).                                                                                              | `idp-admin/keycloak.ts:54`; `realm.json` `otpChoice.phoneAttribute`                                                                                  |

### 5a.2 Target schema

```sql
contact (
  id          text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),  -- HMAC-SHA256(K_id, lower(email):phone); contact_id_matches_chk dropped
  email_enc   bytea NOT NULL,          -- AES-256-GCM envelope (below)
  phone_enc   bytea,
  name_enc    bytea,
  email_bidx  text  NOT NULL,          -- HMAC-SHA256(K_bidx, 'email:' || lower(email)), hex
  phone_bidx  text,                    -- HMAC-SHA256(K_bidx, 'phone:' || phone)
  enc_key_id  text  NOT NULL,          -- which data key encrypted this row (rotation)
  id_scheme   smallint NOT NULL DEFAULT 0,  -- 0 = legacy sha256, 1 = hmac-v1 (sweep target)
  created_at, updated_at
)
UNIQUE (email_bidx);  UNIQUE (phone_bidx) WHERE phone_bidx IS NOT NULL
```

- **Envelope:** `version(1) ‖ key_id_len(1) ‖ key_id ‖ nonce(12) ‖ ciphertext ‖ tag(16)`. The AAD is `'contact.' || field_name`. It is **not** the row id, because the id changes on re-key and ciphertext must survive that untouched.
- **Three independent keys:** `K_enc` (data encryption, a keyring with one active key), `K_bidx` (blind index), `K_id` (contact id). They are separate so each can rotate on its own schedule, and so a leaked index key does not decrypt anything.
- **Encryption happens in the app only.** Keys never enter SQL: statements can be logged, and `pgcrypto` would need the key in the query. As a result, SQL can no longer check email/phone format; that moves to the Zod layer (`ContactSchema`), which already validates them.
- **Normalisation is unchanged:** `normaliseEmail` / `normalisePhone` run **before** the HMAC, so the blind index keeps today's case/format-insensitive uniqueness (Phase 1 §3.1).
- The email/phone format CHECKs and the plaintext unique indexes are dropped only in the contract release.

### 5a.3 Key management

New package `packages/pii-crypto` (`./interface`, `./env`, `./aws-kms`, `./testing`), abstract `PiiKeyProviderBase` with `Result` returns (`.claude/rules/interfaces.md`):

| Provider        | Source                                                                                                                                                                                                                        | Use       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `env` (default) | `PII_ENC_KEYRING` (JSON `{ "active": "k2", "keys": { "k1": "<b64 32B>", "k2": "…" } }`), `PII_BIDX_KEY`, `PII_ID_KEY`                                                                                                         | local, VM |
| `aws-kms`       | the same three values stored **wrapped** (KMS-encrypted data keys) in env or a file; unwrapped once at boot with the pod's IAM role (the same credential path S3 already uses, root `CLAUDE.md` Toolchain) and held in memory | prod      |

- **Boot guard:** under the prod posture (`INSTANCE_ENV`, the shared TLS guard in `shared-primitives/src/config`), missing keys or the `env` provider → `ConfigError`, fail fast. In dev, missing keys → fail fast too, because there is no safe plaintext fallback once R2 lands.
- **The API and the worker share one config fragment** (spread into both `ConfigSchema`s, like the SignalStack fields), so they cannot disagree about keys.
- **Rotation:**

| Key      | How it rotates                                                                                                                                                                                                        | Cost                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `K_enc`  | Add a new key, mark it active: new writes use it. A `pii-reencrypt` script (and an optional worker cron) rewrites rows `WHERE enc_key_id <> active` in batches, idempotently. Remove the old key when the count is 0. | online, cheap            |
| `K_bidx` | A mini expand/contract: add `email_bidx_v2`/`phone_bidx_v2`, dual-write, backfill, switch the unique indexes and lookups, drop v1.                                                                                    | rare; one migration pair |
| `K_id`   | The same one-statement re-key as §5a.4.                                                                                                                                                                               | rare                     |

### 5a.4 Re-keying `contact.id` in one statement

Keys are not in the DB, so the new ids are computed by the app and applied set-based:

1. The script `scripts/contact-rekey.ts` (dry-run by default) decrypts or reads each row, computes `new_id = HMAC(K_id, lower(email):phone)`, and bulk-inserts `(old_id, new_id)` into an `UNLOGGED` staging table `contact_rekey_map` (dropped at the end).
2. One transaction: `LOCK TABLE contact IN SHARE ROW EXCLUSIVE MODE` (writers wait; readers continue), then:
   ```sql
   UPDATE contact c SET id = m.new_id, id_scheme = 1
   FROM contact_rekey_map m WHERE c.id = m.old_id AND c.id_scheme = 0;
   ```
   `ON UPDATE CASCADE` moves `aggregators.contact_id`, `aggregator_orgs.contact_id`, `app_user.contact_id` **in the same statement** (Phase 3 adds no FK to `contact`; any later FK must keep the `ON UPDATE CASCADE` rule); the pre-flight lists every FK to `contact` from `pg_constraint` and refuses to run if any lacks `confupdtype = 'c'`.
3. A collision between a new HMAC id and an existing sha256 id is a 2⁻²⁵⁶ event; the PK would reject it and roll back the whole statement, so it cannot corrupt data.
4. **Stragglers:** a pod still on the previous release writes a sha256 id with `id_scheme` defaulting to 0. The script is re-runnable and picks up only `id_scheme = 0`. It runs once more after the rollout completes; the verify check requires the count to be 0 before the contract release.
5. `DROP CONSTRAINT contact_id_matches_chk` and `DROP FUNCTION contact_id_of` happen in the expand migration (R0), because the new ids fail that CHECK by design. The same release rewrites `scripts/sql/contact-verify.sql` V2 (`:9,25-26`, which calls `contact_id_of`) and moves the golden vectors to TS only (`shared-primitives/src/contact/index.ts:10` documents the SQL twin).

**⚠ REVIEW (D5-3):** once uniqueness lives on the blind indexes, the id no longer needs to be deterministic. A **random** id (`gen_random_bytes(32)` hex) removes `K_id` and its rotation entirely. The cost is losing the one-step `INSERT … ON CONFLICT (id) DO NOTHING`; `linkContact` would conflict on `email_bidx` instead. Recommendation: **keyed HMAC** as agreed in Phase 1 §0.3, because it keeps `linkContact`'s shape; random is the simpler fallback if key handling is a burden.

### 5a.5 Masking

Config-driven, per the doc's ToDo. New `config/pii.yaml` (network-overridable at `config/<network>/pii.yaml`), loaded once at boot:

```yaml
contact:
  encrypt: [email, phone, name]
  mask:
    email: keep_first_and_domain # m***@example.org
    phone: keep_last_4 # +91-XX-XXXX-X123 (Signals format, so pii-mask.ts recognises it)
    name: keep_first # M***
```

| Surface                                                                              | Rule                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New** `/v1/org/*`, `/v1/user/*` responses                                          | Masked by default (`masked: true`, Phase 4 D4-7). Unmasked only for self-reads, or when the actor holds `contact.unmask` (5c) for a user in scope. Every unmask by a non-self actor is logged as an audit event with `user_id` and actor id, never the value. |
| **Existing** endpoints (`/v1/aggregators/profile/me`, approval pages, notify emails) | **Unchanged.** They are self-data or operator emails, and the byte-identical contract rule holds.                                                                                                                                                             |
| Logs                                                                                 | Extend `REDACT_PATHS` (`logger.ts:13`) with `contact.*`, `*.contact.*`, `*.name` under `contact`, `*_enc`, `*_bidx`. `contact.id` stays "never log" (decisions D13), even after it stops being brute-forceable.                                               |
| Ops SQL (`scripts/sql/contact-verify.sql`)                                           | Counts and row ids only; it cannot see plaintext any more.                                                                                                                                                                                                    |

### 5a.6 Rollout

| Step   | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Rollback                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **R0** | Migration `00NN_contact_encrypt.sql` (next free number after the train's 0029): add `email_enc`, `phone_enc`, `name_enc`, `email_bidx`, `phone_bidx`, `enc_key_id`, `id_scheme` (all nullable); **non-unique** indexes on the bidx columns; drop `contact_id_matches_chk` and `contact_id_of()`; `ALTER COLUMN email DROP NOT NULL` (invisible to N−1, which always writes it; the same trick as decisions D10). Inert for N−1. Keys provisioned on every instance **before** R1.                                           | columns unused                                                                                                              |
| **R1** | App **dual-writes** (plaintext + enc + bidx) in `db/contact-writes.ts`; reads stay plaintext. Script `pii-backfill.ts` (dry-run, idempotent, batch, counts only) fills enc + bidx for existing rows.                                                                                                                                                                                                                                                                                                                        | code-only                                                                                                                   |
| **R2** | Gate: verify V-P1 = 0 (rows missing enc/bidx), V-P2 = 0 (bidx collisions). Migration builds `UNIQUE` on `email_bidx` / `phone_bidx` (`CREATE UNIQUE INDEX CONCURRENTLY` outside the migration transaction if the table is large; it is not today). App **switches reads**: lookups by bidx (the four store methods above), rows composed by decrypting. Unique-violation mapping moves to the `contact_*_bidx` constraint names (`aggregator-store/postgres.ts:403` style), same `DUPLICATE_EMAIL`/`DUPLICATE_PHONE` codes. | code rolls back to R1 (still dual-writes)                                                                                   |
| **R3** | App computes new ids as `hmac-v1` (`id_scheme = 1`); run `contact-rekey.ts` (§5a.4). Dual-write continues.                                                                                                                                                                                                                                                                                                                                                                                                                  | the old sha256 ids are gone after the re-key: rolling back to R2 code is still safe, because R2 looks up by bidx, not by id |
| **R4** | App **switches writes**: plaintext columns written as NULL (`DROP NOT NULL` shipped in R0). Re-run the re-key for stragglers.                                                                                                                                                                                                                                                                                                                                                                                               | code rolls back to R3                                                                                                       |
| **R5** | Contract (snapshot first): drop `email`, `phone`, `name`, `contact_email_unique`, `contact_phone_unique`, the email/phone CHECKs; `SET NOT NULL` on `email_enc`, `email_bidx`, `enc_key_id`.                                                                                                                                                                                                                                                                                                                                | irreversible                                                                                                                |

### 5a.7 Out of scope for 5a (**⚠ REVIEW** D5-5)

`registration_invites.email`, `aggregators.invite_email` (target addresses, no person yet), `campaign_job.requested_by` and `campaign_pii_audit.*` (operator audit strings), and Keycloak's copy. The first two can reuse `pii-crypto` in a follow-up. The audit strings stay plaintext because they are append-only operator records. Keycloak is its own store with its own at-rest controls.

---

## 5b. Agreements per `user_type` / `org_type`

### 5b.1 Today

| Fact                                                                                                                                                                                                                                                                    | Evidence                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content is config-as-code: `consent.json` has two fixed audiences, `org` and `aggregator`, each with `terms` + `privacy` (+ optional `bulk_upload_attestation`), each with `current_version` and a `versions[]` list (`version`, `title`, `content`, `effective_from`). | `packages/config-loader/src/consent.schema.ts:23-115`; `config/schemas/aggregator/consent.json` and brand overrides under `config/<network>/<brand>/schemas/aggregator/`                |
| The ledger is append-only, polymorphic, and **write-only** (one method).                                                                                                                                                                                                | `packages/consent-ledger/src/interface.ts:27-45,96-107` (`subjectType: z.enum(['org','aggregator'])`, `termsVersion`, `privacyVersion`, `source`); `0017_aggregator_consent_record.sql` |
| Three writers, all fail-closed and ordered before provisioning.                                                                                                                                                                                                         | `routes/aggregator-registrations.ts:494,649`; `routes/aggregator-orgs.ts:604`; `routes/bulk-uploads.ts:951`; `apps/api/CLAUDE.md` "Consent-ledger write"                                |
| Consent is captured only at registration; there is no re-consent when a version changes.                                                                                                                                                                                | `aggregator-registrations.ts:177` ("records consent only on fresh registration, not on reclaim")                                                                                        |
| Web renders content server-side, with no API round-trip.                                                                                                                                                                                                                | `apps/web/CLAUDE.md` "Consent content has no API round-trip"                                                                                                                            |

### 5b.2 Target model

**Config stays the reviewed source; the DB becomes the runtime registry** (D5-6). `consent.json` gains a v2 block, and the loader maps the legacy `audiences` block onto it so every existing file stays valid:

```jsonc
{
  "agreements": {
    "coordinator_terms": {
      "kind": "terms", // terms | privacy | consent | attestation
      "applies_to": { "user_type": ["Coordinator"], "org_type": ["Aggregator"] },
      "required": true,
      "current_version": 2,
      "versions": [
        { "version": 1, "title": "…", "content": "…", "effective_from": "…" },
        {
          "version": 2,
          "title": "…",
          "content": "…",
          "effective_from": "…",
          "requires_reconsent": true,
        },
      ],
    },
  },
}
```

- Legacy mapping: `audiences.aggregator.documents.terms` → `aggregator_terms` with `applies_to.user_type=[Coordinator]`; `audiences.org.*` → `applies_to.user_type=[Admin], org_type=[Aggregator]`; `bulk_upload_attestation` → `kind: attestation`, `applies_to` coordinators, captured per upload (unchanged behaviour).
- `__SUPPORT_EMAIL__` rendering at load is kept (root `CLAUDE.md`, config-loader `./consent`).

Tables (new migration):

```sql
agreement          (id uuid PK, key text UNIQUE, kind text, required bool, applies_to jsonb, source text  -- 'config' | 'api'
                    , created_at, updated_at)
agreement_version  (agreement_id uuid FK, version int, title text, content text, effective_from timestamptz,
                    requires_reconsent bool, PRIMARY KEY (agreement_id, version))          -- immutable once written
agreement_link     (agreement_id uuid FK, subject_type text CHECK IN ('org','user'), subject_id uuid,
                    PRIMARY KEY (agreement_id, subject_type, subject_id))                   -- explicit per-org/user links (doc)
agreement_acceptance (id uuid PK, agreement_id uuid, version int, subject_type text CHECK IN ('org','user'),
                    subject_id uuid, accepted_by uuid NULL /* app_user.id */, network text, brand text,
                    source text, accepted_at timestamptz, created_at)                        -- append-only, no FK on subject (as 0017)
```

- **Seeding:** at boot, the API upserts `agreement` + `agreement_version` from config (idempotent; a version already present with different content → `ConfigError`, because published versions are immutable).
- **`aggregator_consent_record` is frozen, not migrated.** It is append-only and must not be rewritten. A view `agreement_acceptance_all` unions it (each legacy row split into a terms row and a privacy row, subjects mapped through `aggregators.user_id` / `aggregator_orgs.owner_user_id` / the Phase 3 org id) with the new table.
- **Which agreements apply to a subject** = `applies_to` matches the user's `user_type`/`serves` and the org's `org_type`, **plus** any `agreement_link` rows for the user or their org.

### 5b.3 Ledger contract

`ConsentLedgerBase` (`packages/consent-ledger/src/interface.ts:96`) gains two abstract methods; `postgres.ts`, `memory.ts`, `testing.ts` follow (`.claude/rules/interfaces.md` §1, §6):

```ts
export const RecordAgreementAcceptanceInputSchema = z.object({
  agreementKey: z.string().min(1), version: z.number().int().min(1),
  subjectType: z.enum(['org', 'user']), subjectId: z.string().uuid(),
  acceptedBy: z.string().uuid().nullish(), network: z.string().min(1), brand: z.string().min(1).nullish(),
  source: z.string().min(1),
});
abstract recordAgreementAcceptances(inputs: RecordAgreementAcceptanceInput[]): Promise<Result<AgreementAcceptance[], BaseError>>; // one transaction
abstract findLatestAcceptances(subject: { subjectType: 'org' | 'user'; subjectId: string }): Promise<Result<AgreementAcceptance[], BaseError>>;
```

`recordRegistrationConsent` stays, and is still called by the old routes until R4 (its contract and the legacy table are untouched).

### 5b.4 Re-consent

- `outstandingAgreements(actor)` = required agreements for the actor whose latest accepted version is below the newest version with `requires_reconsent: true` that is past its `effective_from`.
- **API:** the Phase 4 `requireActor` wrapper returns `403 AGREEMENT_REQUIRED` with `fields.agreements: [{ key, version }]` on the new routes, except `user/read/me` and the accept route. The existing coordinator routes are **not** gated in the API (contract rule); the web gates them instead (next point).
- **Web:** the `(protected)` and `(console)` layouts call `GET /v1/agreement/outstanding` server-side (the same pattern as `fetchSupportEnabled`) and render the scroll-gated `ConsentModal` (`components/consent/`) until accepted.
- Accepting writes the ledger row **before** anything that depends on it (the fail-closed rule).

### 5b.5 APIs (doc: "create/configure an agreement and link to an org or user")

| Route                                                      | Who                                                                     | Request / response                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/agreement/create`                                | NF admin (`agreement.manage`)                                           | `CreateAgreementRequestSchema` `{ key, kind, required, applies_to }` → `{ agreement: AgreementSchema }`                                                                                                                                 |
| `POST /v1/agreement/version/create/<id>`                   | NF admin                                                                | `CreateAgreementVersionRequestSchema` `{ title, content, effective_from, requires_reconsent }` → `{ version: AgreementVersionSchema }`. The version number is server-assigned (`max + 1`). No update or delete: versions are immutable. |
| `PATCH /v1/agreement/link/update/<id>`                     | NF admin; org admin for their own org's users                           | `{ link?: Subject[], unlink?: Subject[] }`                                                                                                                                                                                              |
| `GET /v1/agreement/read/<id>`, `POST /v1/agreement/search` | NF admin, org admin (read-only)                                         | `AgreementSchema` + versions                                                                                                                                                                                                            |
| `GET /v1/agreement/outstanding`                            | any user                                                                | `{ agreements: { key, version, title, content, kind }[] }`                                                                                                                                                                              |
| `POST /v1/agreement/accept`                                | any user, for self (and org admin for their org: `subject_type: 'org'`) | `AcceptAgreementsRequestSchema` `{ items: { key, version }[] }` → `201 { acceptances: AgreementAcceptanceSchema[] }`                                                                                                                    |

API-created agreements have `source: 'api'` and are never overwritten by the boot seeding; a config agreement cannot be edited by API (`AGREEMENT_CONFIG_MANAGED`).

### 5b.6 Rollout

| Step   | Content                                                                                                                                                                                                                                              | Rollback                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **R0** | Migration: the four tables + the union view. Loader accepts v2 `agreements` **and** legacy `audiences`.                                                                                                                                              | inert                                                       |
| **R1** | Boot seeding; ledger new methods; **dual-write**: every existing consent writer also writes `agreement_acceptance` rows in the same fail-closed step (both must succeed, or the existing rollback runs). Read API (`outstanding`, `read`, `search`). | code-only; the legacy table is still complete               |
| **R2** | Re-consent gate in the web layouts and on the Phase 4 routes; `accept` route.                                                                                                                                                                        | turn the gate off by config (`AGREEMENT_RECONSENT_ENABLED`) |
| **R3** | Management APIs (`create`, `version/create`, `link/update`) + console screens.                                                                                                                                                                       | code-only                                                   |
| **R4** | Old writers stop calling `recordRegistrationConsent`; the legacy table stays as frozen history, read through the view.                                                                                                                               | code rolls back to R3 (dual-write)                          |

---

## 5c. RBAC: permission sets

### 5c.1 Today

| Fact                                                                                                                                                                                         | Evidence                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| No permission model. An approved coordinator can call everything on the coordinator routes. The only extra check is data-scope: `aggregator_type` must equal the requested participant type. | `bulk-uploads.ts:862-895` (`requireAuth`, `enforceAggregatorType`); `registration-links.ts:782-815` |
| Realm roles: `org_owner` (assigned, never checked in the API), `signals_participant`, `signals_admin`. No client roles.                                                                      | `infra/keycloak/realms/realm.json` roles                                                            |
| Access tokens live 300 s.                                                                                                                                                                    | `realm.json` `accessTokenLifespan: 300`                                                             |
| Feature flags live in `config/features.yaml` (`bulkOnboarding`, `linkOnboarding`, …) and are validated by `schema-service`.                                                                  | `config/features.yaml:9-15`; `packages/schema-service/src/features.schema.ts`                       |

### 5c.2 Model

- **Permissions are code** (enforcement points reference them); **sets and mappings are config**. Catalogue in `packages/shared-primitives/src/rbac` as a Zod enum `PermissionSchema`:

| Feature                 | Permissions                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Bulk upload of profiles | `bulk_upload.create`, `bulk_upload.read`                                              |
| Registration links      | `registration_link.manage`, `registration_link.read`                                  |
| Dashboard / export      | `dashboard.read`, `dashboard.export`                                                  |
| Campaigns               | `campaign.export`, `campaign.voice`, `campaign.email`                                 |
| Support                 | `support.submit`                                                                      |
| Orgs (Phase 5 APIs)     | `org.read`, `org.update`, `org.create_child`, `org.users.manage`, `org.parent.update` |
| Users (Phase 5 APIs)    | `user.read`, `user.invite`, `user.update`, `contact.unmask`                           |
| Agreements (5b)         | `agreement.manage`                                                                    |

- **Config** `config/rbac.yaml` (network/brand-overridable like `consent.json`), loaded once at boot and validated against `PermissionSchema` (an unknown permission → `ConfigError`):

```yaml
permission_sets:
  coordinator_default: [bulk_upload.create, bulk_upload.read, registration_link.manage, registration_link.read,
                        dashboard.read, dashboard.export, campaign.export, campaign.voice, campaign.email, support.submit, user.read]
  org_admin_default:   [org.read, org.update, org.create_child, org.users.manage, user.read, user.invite, user.update]
  nf_admin:            ['*']
defaults:                        # user_type (+ org_type for admins) → sets
  Coordinator:             [coordinator_default]
  Admin@Aggregator:        [org_admin_default]
  Admin@NetworkFacilitator:[nf_admin]
```

- **Default mapping = today's behaviour.** `coordinator_default` grants exactly what an approved coordinator can do now. A unit test asserts that, for the shipped config, every existing coordinator route is allowed for a default coordinator, so wiring the checks changes nothing.
- **Per-user grants (optional, R3):** `app_user_permission_set(user_id, set_key, granted_by, granted_at)`, **additive** only (no deny rules), managed through `PATCH /v1/user/metadata/update` by admins with `org.users.manage`. **⚠ REVIEW** D5-10: needed now, or config-only defaults first?
- `features.yaml` flags stay instance-level kill switches, checked **before** permissions.

### 5c.3 Enforcement point

- Keep the per-file wrapper pattern (`apps/api/CLAUDE.md:5-7`). Each wrapper gets a second argument: `requireAuth(req, 'bulk_upload.create')`. In the existing files that is a one-line change per handler; the Phase 4 `policy.ts` bodies become `hasPermission(actor, perm) && inScope(actor, target)`.
- Every route declares `config: { permission: '<perm>' }` or `config: { permission: 'public' | 'service' }`. The Phase 4 route-guard test extends to **all** routes: a route without a declaration fails CI. This closes the "nothing prevents a new route from omitting the call" gap for the whole API, not just the new routes.
- Failure → `403 FORBIDDEN` with `fields.permission` (the name only).
- Data-scope checks (`enforceAggregatorType`, the token↔`parent_org_id` binding in `aggregator-approvals.ts`) stay as they are: they are scope, not permission. They move to `serves` in a later step once `aggregators.type` is retired.

### 5c.4 Token claims or DB lookup

| Option                                                    | For                                                                                                                                                                                                                                      | Against                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Realm/client roles in the token                           | No DB hit; Keycloak-native.                                                                                                                                                                                                              | Stale for up to 300 s after a change; every set/mapping change is a realm change in **two** repos (this one and bluedots-automation, which owns the deployment realm); permission sets per network would need per-network realms. |
| **DB + config, resolved per request** (recommended, D5-9) | Phase 4 `resolveActor` already loads `app_user` + memberships in one query; permissions are a pure in-memory function of `(user_type, org_type, grants)` over config loaded at boot. Changes apply at the next request. No realm change. | One indexed query per request (already paid in Phase 4); the existing coordinator routes add that query (today they read only the token).                                                                                         |

Coordinator routes on the old wrappers resolve the actor by `aggregator_id` → `aggregators.user_id` → `app_user` (the same indexed path as Phase 4 §2.2 step 4). If the per-request cost shows up, add a Redis cache keyed by `kc_sub` with a 30 s TTL, invalidated on membership or grant writes. Not in the first release.

### 5c.5 Rollout

| Step              | Content                                                                                                                                                                                                                   | Rollback              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **R0**            | Catalogue, `config/rbac.yaml`, loader + boot validation, `hasPermission()`. No enforcement. Unit test: default mapping ≡ today's coordinator access.                                                                      | code-only             |
| **R1**            | Enforce on the Phase 4 routes (they are new, so no behaviour change for existing users). The route-guard test covers all routes, with the old routes declaring their permission.                                          | code-only             |
| **R2**            | Enforce on existing coordinator routes, behind `RBAC_ENFORCE_LEGACY` (default **log-only**: a would-deny is logged at `warn` with route + permission + `user_id`). Flip to enforce per instance after a clean log window. | flag back to log-only |
| **R3** (optional) | `app_user_permission_set` migration + grant management + console UI.                                                                                                                                                      | table unused          |

---

## 6. Verification

| Track                                                                 | Check                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5a SQL (`scripts/sql/pii-verify.sql`, read-only, counts and ids only) | V-P1 rows missing `email_enc`/`email_bidx`/`enc_key_id`; V-P2 duplicate bidx values; V-P3 rows with `id_scheme = 0` (must be 0 before R5); V-P4 rows with `enc_key_id` not in the active keyring (rotation progress); V-P5 FKs to `contact` without `ON UPDATE CASCADE` (must be 0 before the re-key).                                             |
| 5a unit                                                               | Envelope round trip; wrong AAD or key fails; the blind index is stable across case/format variants (reusing the Phase 1 golden vectors, now keyed); masking rules per config; `REDACT_PATHS` covers `*_enc`, `*_bidx`, `contact.*` (logger test).                                                                                                  |
| 5a integration (Postgres CI job)                                      | The re-key cascades to every referencing table in one statement; concurrent writers wait on the lock and succeed afterwards; a straggler inserted mid-rollout is picked up by the second run; unique violations on bidx map to today's codes; byte-identical `JSON.stringify` of the existing profile response before/after (the Phase 1 M3 test). |
| 5b                                                                    | Seeding is idempotent and refuses a changed published version; dual-write fail-closed (either ledger failing rolls back the subject); `outstandingAgreements` for each `user_type`×`org_type`; the union view returns legacy rows split into terms/privacy.                                                                                        |
| 5c                                                                    | Default mapping ≡ today's access (every existing route × default coordinator = allow); route-guard test over all routes; log-only mode never denies.                                                                                                                                                                                               |
| E2E (`aggregator-e2e` skill)                                          | Register → approve → log in → dashboard, with encryption, re-consent and RBAC all on; bump a terms version with `requires_reconsent` → modal on next page load.                                                                                                                                                                                    |

## 7. Risks

| Risk                                                     | Mitigation                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key loss makes contact data unrecoverable                | KMS-wrapped keys in prod; key backup is part of the instance runbook; R5 (plaintext drop) requires a snapshot **and** a restore-and-decrypt drill on a clone. |
| Key leak                                                 | Separate keys per purpose; rotation paths for each (§5a.3); a leaked `K_bidx` or `K_id` reveals only equality, not values.                                    |
| Mixed fleet writes sha256 ids after the re-key           | `id_scheme` column + a re-runnable re-key script + the V-P3 gate.                                                                                             |
| A Phase 3/4 FK to `contact` lacks `ON UPDATE CASCADE`    | V-P5 pre-flight refuses the re-key.                                                                                                                           |
| Lookups become slower or lose the index                  | Bidx columns are plain btree `text`; integration test asserts index use, as Phase 1 M2 did.                                                                   |
| Ops lose the ability to query contacts by value in SQL   | A small `pii-lookup.ts` script computes the bidx for an input and prints row ids; documented in the runbook.                                                  |
| Re-consent locks users out when content is misconfigured | `AGREEMENT_RECONSENT_ENABLED` kill switch; `effective_from` lets a version be staged ahead.                                                                   |
| RBAC denies a legitimate call on an existing route       | Log-only mode first (`RBAC_ENFORCE_LEGACY`); the default-mapping equivalence test.                                                                            |
| Masking breaks a web form that expects plaintext         | Masking applies only to the Phase 4 routes; `pii-mask.ts` already keeps the geocoder away from masked values.                                                 |

## 8. Decisions

| #              | Decision                  | Options                                                            | Recommended                                                                                                  |
| -------------- | ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| D5-1           | Where encryption runs     | pgcrypto in SQL / **app-side**                                     | App-side; keys never reach SQL.                                                                              |
| D5-2 ⚠ REVIEW  | Key source                | env only / KMS only / **pluggable (env default, AWS KMS in prod)** | Pluggable; prod posture refuses the env provider. Which KMS (AWS vs other) depends on the deployment target. |
| D5-3 ⚠ REVIEW  | New `contact.id`          | **keyed HMAC** / random                                            | Keyed HMAC (Phase 1 §0.3 plan); random is the simpler fallback.                                              |
| D5-4           | Blind-index scope         | **email + phone** / + name                                         | Email and phone only; name is not a lookup key and a name bidx leaks equality across people.                 |
| D5-5 ⚠ REVIEW  | Other PII columns         | contact only / **contact now, invites next, audit strings never**  | As recommended; confirm that operator audit strings stay plaintext.                                          |
| D5-6 ⚠ REVIEW  | Agreement source of truth | config only / DB only / **config seeds DB, API adds more**         | Config seeds DB; API-created agreements for per-org/per-user needs.                                          |
| D5-7           | Legacy consent table      | migrate rows / **freeze + union view**                             | Freeze; append-only rows are never rewritten.                                                                |
| D5-8 ⚠ REVIEW  | Re-consent enforcement    | API-wide / **web layouts + Phase 4 routes only**                   | Web + new routes; the old API contract stays byte-identical.                                                 |
| D5-9           | Permission source         | token roles / **DB + config per request**                          | DB + config (§5c.4).                                                                                         |
| D5-10 ⚠ REVIEW | Per-user grants           | **defaults only first**, additive grants in R3 / full custom roles | Defaults first; additive grants only if a real need appears. No deny rules.                                  |
| D5-11          | Legacy route enforcement  | enforce immediately / **log-only then enforce per instance**       | Log-only first.                                                                                              |
| D5-12          | Track order               | **5c → 5b → 5a** / 5a first                                        | 5c first (no data change), 5a last (the only irreversible step).                                             |
