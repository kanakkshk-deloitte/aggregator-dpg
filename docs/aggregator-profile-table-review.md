# `aggregator_profile` — is the table still needed?

**Date:** 2026-09-29
**Repo:** `aggregator-dpg` @ `a480002`
**Question:** is there a practical need for the `aggregator_profile` table, and what does deleting it mean?

> **Resolved — the table has been dropped.** The removal recommended here landed
> in #818: migration `0023_drop_aggregator_profile.sql` drops `aggregator_profile`.
> This review is kept as the rationale; the code paths it describes no longer exist.

**Status:** claims below were independently fact-checked against the code by a
second pass. The core thesis held; three supporting arguments were wrong and have
been corrected in place (the `contact.name` CHECK guarantee, the
`profile_completed_at` reasoning, and the §5b option-2 blast radius).

**Short answer:** the table is wired end-to-end but carries no data in any
production path. Every field it holds is either (a) duplicated by a column on
`aggregators`, (b) superseded by the `aggregators.profile` jsonb added in
migration 0018, or (c) written only by a code path the UI never calls. Removal
is defensible, but it is a **behaviour change on two live API contracts**, not a
pure cleanup — see [Blast radius](#5-blast-radius-of-deleting-it).

---

## 1. What the table is

Created in migration `0005_aggregator_profile.sql` as a 1:1 secondary row off
`aggregators`, to hold fields that are filled out _after_ login (registration
only needed enough to authenticate).

`apps/api/drizzle/migrations/0005_aggregator_profile.sql`:

```sql
CREATE TABLE IF NOT EXISTS "aggregator_profile" (
  "aggregator_id" uuid PRIMARY KEY REFERENCES "aggregators"("id") ON DELETE CASCADE,
  "contact_name" text,
  "personas" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "services" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "verified_certificate" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "profile_completed_at" timestamptz,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
  -- + 3 CHECKs (:124-126): personas / services / verified_certificate
  --   each asserted jsonb_typeof(...) = 'array'
);
```

Plus three indexes (`:129-131`) — two GIN on `personas` / `services` (both
`jsonb_path_ops`) and one btree on `profile_completed_at`. The "Beckn catalog
discovery" justification for the GIN pair is in the Drizzle mirror
(`schema.ts:411`), not in the SQL.

Drizzle mirror: `packages/db-schema/src/schema.ts:377-416`.

**The mirror drifts from the SQL.** `schema.ts:412-413` declares the GIN indexes
without `jsonb_path_ops`, and declares none of the three CHECK constraints. It
also uses the deprecated object-return `extraConfig` form that the same file
warns against at `:361`. Relevant below: §5a's verification query and §5c's drop
plan both assume the Drizzle definition is a faithful mirror — it is not.

### Code that exists to serve it

| Path                                                      | LOC | Role                                          |
| --------------------------------------------------------- | --- | --------------------------------------------- |
| `apps/api/src/services/aggregator-profile-store/`         | 462 | Store port + Postgres + in-memory + test fake |
| `apps/api/src/routes/aggregator-profile.ts`               | 510 | `GET`/`PATCH /v1/aggregators/profile/me`      |
| `apps/web/src/services/profile.service.ts`                | 203 | BFF client + display mapping                  |
| `apps/api/drizzle/migrations/0005_aggregator_profile.sql` | 154 | Creation                                      |

Test files that touch it (9): `aggregator-profile.test.ts`,
`aggregator-registrations{,.org,.invite}.test.ts`, `aggregator-approvals.test.ts`,
`aggregator-maintenance.test.ts`,
`aggregator-profile-store/__tests__/postgres.test.ts`, and two in
`packages/db-schema/src/__tests__/`.

---

## 2. What actually writes to it

Exactly two call sites in production code.

### 2a. Registration — inserts an empty stub

`apps/api/src/routes/aggregator-registrations.ts:510-521`:

```ts
const profile = await profileStore.create({
  aggregatorId,
  createdBy: 'self',
  updatedBy: 'self',
});
```

No field values — though `create()` _could_ take them:
`CreateAggregatorProfileInput` declares `contactName` / `personas` / `services` /
`verifiedCertificate` as optional (`aggregator-profile-store/interface.ts:30-38`).
The caller passes none, so `contact_name` stays `NULL`; `personas` / `services` /
`verified_certificate` stay `[]`; `profile_completed_at` stays `NULL`. This is
the only `profileStore.create` call site in the API.

The _real_ registration payload goes somewhere else — the parent table, five
lines earlier (`:482-483`):

```ts
profile: buildAggregatorProfile(body as unknown as Record<string, unknown>),
profileRef: resolveProfileRef('registration.v1.json'),
```

### 2b. `PATCH /v1/aggregators/profile/me` with `body.profile` — no caller

`apps/api/src/routes/aggregator-profile.ts:316-380` handles `body.profile.*` and
stamps `profile_completed_at` (store write at `:371`). The web client exposes it
as `profileService.edit()` (`profile.service.ts:123`).

`grep -rn "\.edit(" apps/web/src` returns **one hit, and it is a test**:
`apps/web/src/__tests__/services/profile.service.test.ts:121`.

The two profile screens do not call it:

- `/profile` (`ProfileFormView.tsx`) — read-only by design. Its own comment at
  `:133`: _"the profile is display-only"_. Its mapper at `:37` states
  _"post-login extras (personas, services) are intentionally omitted"_.
- `/profile/complete` (`ProfileCompleteView.tsx`) — has a submit button, but it
  `PUT`s `{ data, consent }` (`:76-81`). The BFF `PUT` aliases to `PATCH`
  (`app/api/aggregator/profile/me/route.ts:49-51`) and forwards the parsed body
  untouched (`:38-41`); `callApi` just `JSON.stringify`s it
  (`lib/upstream-client.ts:82`). The API's `ProfileUpdateBodySchema` is
  `.strict()` on `{ aggregator?, profile? }` **and** `.refine()`s that at least
  one is present (`aggregator-profile.ts:75-84`), wired as `schema.body` at
  `:239` against the zod validator compiler (`app.ts:113`). **`{data, consent}`
  fails on both counts → 400.** Nothing in the chain translates the body. The
  same view's loader reads `body.data` / `body.consent` (`:56-57`), keys the GET
  response does not contain. This screen is stale against the post-0005 contract
  and cannot currently save.

  **It is also unreachable.** No nav entry and no programmatic link to
  `/profile/complete` exists anywhere in `apps/web/src` — the sidebar offers only
  `/onboarding`, `/profile`, `/dashboard` (`components/shell/Sidebar.tsx:35-37`).
  A user cannot get to it, so the broken save is latent, not user-facing.

**Net:** every `aggregator_profile` row in the database is an all-defaults stub.

---

## 3. What reads it

`GET /v1/aggregators/profile/me` merges it into the response
(`aggregator-profile.ts:196-230`), contributing five keys: `contact_name`,
`personas`, `services`, `verified_certificate`, `profile_completed_at`, plus the
derived `is_complete` and a `max(updated_at)` tiebreak.

Consumers of those keys, per field:

| Field                                  | Consumer                                                                                                 | Verdict                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `contact_name`                         | `profile.service.ts:139` — second operand in `api.contact?.name \|\| api.contact_name \|\| identityFull` | Redundant in practice. See the note below — the guarantee is app-layer, not DB-layer. |
| `personas`                             | `profile.service.ts:157` → `beneficiaries` display string                                                | Always `[]` → always empty string.                                                    |
| `services`                             | `profile.service.ts:162` → `sectors` display string                                                      | Always `[]` → always empty string.                                                    |
| `verified_certificate`                 | typed as `unknown[]` at `profile.service.ts:89`; never read                                              | Dead.                                                                                 |
| `profile_completed_at` / `is_complete` | `ProfileCompleteView.tsx:20` declares `is_complete` on its body type but never branches on it            | Dead. Always `false` — see the note below.                                            |

**On `contact_name`:** the DB does _not_ guarantee the first operand wins.
`contact` is `jsonb NOT NULL` (`0005:56`) but `aggregators_contact_shape_chk`
(`0005:79-84`) only asserts `jsonb_typeof(contact->'name') = 'string'` — an
**empty string passes**, and `'' || api.contact_name` falls through. Non-emptiness
comes only from the app layer: `BecknContactSchema` declares
`name: z.string().min(1).max(200)`
(`packages/shared-primitives/src/beckn/index.ts:37`), enforced on both write paths
(`aggregator-registrations.ts:237`, `aggregator-profile.ts:60`). The conclusion —
`contact_name` is redundant — holds; the reason is Zod, not the CHECK.

**On `profile_completed_at`:** `isProfileComplete()`
(`aggregator-profile.ts:470-480`) is trivially satisfiable — non-blank
`contactName` + ≥1 persona + ≥1 service, all three settable via
`PATCH body.profile`. It is always `false` because **no client calls PATCH**, not
because the predicate is unsatisfiable.

No query anywhere filters on `personas` or `services`. The two GIN indexes
justified as "Beckn catalog discovery" have **no reader** — grep for `personas`
outside the profile route/store returns only the schema-registry validator
(`services/schema-registry/index.ts`), which is an in-memory YAML map, not a
table query.

Two store methods are dead in production:

- `deleteByAggregatorId` (`interface.ts:84`, `postgres.ts:122`, `memory.ts:81`) —
  only callers are `aggregator-profile-store/__tests__/postgres.test.ts:326,335,348`.
  Corroborated by coverage: `FNDA:0` for both impls (`apps/api/coverage/lcov.info:14016,14119`).
- `markCompleted` (`interface.ts:80`, plus both impls) — never called outside tests.

---

## 4. Why it became redundant — migration 0018

`0018_aggregator_profile_payload.sql` added to **`aggregators`** (and
`aggregator_orgs`):

```sql
ALTER TABLE "aggregators"
  ADD COLUMN IF NOT EXISTS "profile"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "profile_ref" text;
```

Its header states the intent plainly: _"Fields added by a schema revision land
in `profile` instead of getting their own column, so the next revision is a
JSON-schema edit with no migration."_ `profile_ref` names which schema variant
produced the payload.

That is the same job `aggregator_profile` was created for — extensible,
post-registration, schema-driven profile data — solved on the parent row, with
the extra ability to version the contract. The original design docs describe
exactly this shape but as a _separate_ table:

- `README.md:251-252` — `aggregator_profile_schema (id, version, schema_json, ...)`
  - `aggregator_profile (aggregator_id PK, schema_version, values_json, updated_at)`
- `docs/issues/product/PH-1-features.md:167` — "Server-side writes to
  `aggregator_profile.values_json`"

Neither `aggregator_profile_schema` nor `values_json` was ever built. 0018
delivered the capability on `aggregators.profile` + `aggregators.profile_ref`
instead. `aggregator_profile` is the vestige of the superseded design — it kept
the name but never got the mechanism.

### Field-by-field: where each one lives now

| `aggregator_profile` column                               | Replacement                                                                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `contact_name`                                            | `aggregators.contact->>'name'` (column NOT NULL; non-empty enforced by `BecknContactSchema`, not by the CHECK — see §3) |
| `personas`                                                | `aggregators.profile` jsonb (schema-declared), validated against schema registry at app layer                           |
| `services`                                                | same                                                                                                                    |
| `verified_certificate`                                    | `aggregators.profile` jsonb; no consumer exists either way                                                              |
| `profile_completed_at`                                    | Derivable — no independent source of truth needed once fields live on `aggregators`                                     |
| `created_by` / `updated_by` / `created_at` / `updated_at` | `aggregators` already has all four                                                                                      |

There is no cardinality argument for the split: the row is 1:1, PK-on-FK, created
in the same request as its parent, and `ON DELETE CASCADE`.

---

## 5. Blast radius of deleting it

### 5a. Data loss

None, in the strict sense — every row is an all-defaults stub (§2). Verify
against the live DB before acting:

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE contact_name IS NOT NULL)            AS has_name,
       count(*) FILTER (WHERE jsonb_array_length(personas) > 0)    AS has_personas,
       count(*) FILTER (WHERE jsonb_array_length(services) > 0)    AS has_services,
       count(*) FILTER (WHERE jsonb_array_length(verified_certificate) > 0) AS has_cert,
       count(*) FILTER (WHERE profile_completed_at IS NOT NULL)    AS completed
FROM aggregator_profile;
```

Anything other than `total > 0` with all other counts `0` invalidates the
analysis in §2 and the plan needs a backfill into `aggregators.profile`.

### 5b. API contract — this is the real cost

`GET /v1/aggregators/profile/me` currently returns seven keys sourced from the
table: `contact_name`, `personas`, `services`, `verified_certificate`,
`profile_completed_at`, `is_complete`, and a `updated_at` that takes
`max(profile.updated_at, aggregator.updated_at)`. `PATCH` accepts a `profile`
sub-object with four of them.

Two options:

1. **Keep the wire shape, change the source.** `GET` serves the five read keys
   from `aggregators` (`contact->>'name'`, `profile->'personas'`,
   `profile->'services'`, `profile->'verified_certificate'`) and computes
   `is_complete` inline. `PATCH body.profile.*` writes into `aggregators.profile`.
   No client changes, no contract change, and the values involved are empty today
   regardless. **Recommended.**
2. **Drop the keys.** Smaller store diff, but it breaks in two places, server
   first:
   - **Server 500 before any client sees it.** `ProfileCommonResponseShape`
     (`aggregator-profile.ts:104-121`) declares `contact_name`, `personas`,
     `services`, `verified_certificate`, `profile_completed_at` and `is_complete`
     as **required**. Fastify serializes the reply through it, so omitting them
     fails response serialization. (`.passthrough()` on the response schemas at
     `:130`/`:137` does not help — it tolerates _extra_ keys, not missing ones.)
     Dropping the keys therefore means editing the response schemas too.
   - **Then a client `TypeError`.** `ProfileApiResponse`
     (`profile.service.ts:71-103`) is a bare TS interface with **zero runtime
     validation**, and `mapToAggregatorProfile` dereferences `api.personas.map(...)`
     (`:157`), `api.locations.map(...)` (`:158`) and `api.services.map(...)`
     (`:162`) unguarded — a runtime crash on the dashboard, not a type error.

   Requires a coordinated API + web change.

### 5c. Code to remove (option 1)

- `apps/api/src/services/aggregator-profile-store/` — 462 LOC, whole directory
- `packages/db-schema/src/schema.ts:375-416` (375 is the section comment) + type
  exports at `:883-884`
- **`apps/api/src/index.ts:9`** — `export type { AggregatorProfile }`, a
  package-level public export surface
- Stub-create block, `aggregator-registrations.ts:510-521` — also deletes a
  compensating-rollback branch (`aggregatorStore.deleteById` on failure), so
  registration gets one fewer failure mode
- Profile-store wiring in `aggregator-profile.ts` (store lookup, `existing` read,
  `isProfileComplete` call sites) — the route itself stays
- The 9 test files listed in §1. Note only 7 assert anything about the table;
  `aggregator-approvals.test.ts:76,111` and `aggregator-maintenance.test.ts:33-54`
  merely wire `AggregatorProfileStoreFake` via `_setAggregatorProfileStore` and
  need the wiring removed, not assertions rewritten.
- New migration `00NN_drop_aggregator_profile.sql`: `DROP TABLE aggregator_profile CASCADE;`
  (takes the three indexes, the three CHECKs and the
  `aggregator_profile_set_updated_at` trigger with it; leave the shared
  `set_updated_at()` function alone — `aggregators` still uses it)

### 5d. Things that are NOT blockers but must be decided

- **`/profile/complete` is already broken and unreachable** (§2b). Deleting the
  table does not break it further. Because no link to it exists, this is latent
  debt rather than a live user-facing bug — file it separately; it should not
  gate the migration. Decide whether the screen is being revived (then it needs
  rewiring to the new storage) or deleted.
- **`aggregators.profile` is write-only across the entire API.** The store reads
  the column out of the DB (`aggregator-store/postgres.ts:333-334`), but **no
  route anywhere emits it** — not `GET /v1/aggregators/profile/me`
  (`aggregator-profile.ts:187-226`, schema `:123-130`), not the PATCH echo
  (`:402-423`). Registration extras captured at signup are unreadable through any
  endpoint. Option 1 fixes this as a side effect; it is arguably the stronger
  reason to do the work than the table removal itself.

- **Fix the Drizzle↔SQL drift** (§1) if any of this work lands: `schema.ts:412-413`
  is missing `jsonb_path_ops` and all three CHECKs. Harmless once the table is
  dropped, but if the decision goes the other way (populate rather than delete),
  this is a real defect — and it means the Drizzle file cannot be trusted as the
  source of truth when writing the drop migration.
- **Docs to update:** `README.md:251-252`, `SETUP.md:266`,
  `docs/aggregator-app-technical-design.md:526,898`,
  `docs/issues/platform/P-04-features.md:51,56`,
  `docs/issues/product/PH-1-features.md:136,167`,
  `docs/issues/platform/P-14-features.md:9`. Several of these also reference
  `aggregator_profile_schema`, which never existed. Caveat: `SETUP.md:266`
  describes `aggregator_profiles` (**plural**) — the pre-0005 table that migration
  0005 already drops at `:35`. It is stale about a different table, so fixing it
  is unrelated housekeeping.

---

## 6. Recommendation

**Yes — delete it, via option 1 (keep the wire shape, move the source to
`aggregators.profile`).** Run the §5a query against dev/staging first.

Rationale:

- 1:1 with the parent, created in the same request, cascade-deleted. The split
  buys nothing structurally.
- Every column is duplicated (`contact_name`, audit fields) or superseded
  (`personas` / `services` / `verified_certificate` → `aggregators.profile`).
- No production write path sets a single value; every row is a stub.
- The indexes justified by "Beckn catalog discovery" have no reader.
- It costs ~460 LOC of store scaffolding, a rollback branch in the registration
  hot path, a `NOT_FOUND` failure mode on every profile read
  (`aggregator-profile.ts:175-178`, commented _"should never fire"_), and an
  extra round trip on both `GET` and `PATCH`.

**Counter-consideration, stated honestly:** the table's design intent —
catalog-queryable `personas` / `services` — is not wrong, it is _unbuilt_. If
Beckn catalog discovery is near-term roadmap and will query "all aggregators
supporting persona X", jsonb-in-a-shared-column is a worse home for that than a
dedicated indexed table. The decision hinges on whether that query is coming.
If it is, the better move is to _populate_ the table (wire the UI, fix
`/profile/complete`) rather than drop it. If it is not scheduled, the table is
speculative structure and should go — `aggregators.profile` + a GIN index on
`(profile->'personas')` can serve the same query later if needed.

**Sequencing if proceeding:**

1. Run §5a verification query against dev + staging.
2. Move `GET`/`PATCH` handlers to read/write `aggregators.profile`; keep response
   keys identical. Tests should pass unchanged except store-fake wiring.
3. Fix `/profile/complete` to send `{ aggregator, profile }` (or repoint the BFF
   `PUT` to translate `{data, consent}`).
4. Drop the stub-create in registration.
5. Ship the `DROP TABLE` migration after (2)-(4) are deployed and stable — not in
   the same release.
6. Update the docs listed in §5d.
