# Campaign PII-Action Audit Log

**Umbrella:** Blue-Dots-Economy/signals-dpg#237 · **Ticket:** aggregator-dpg#617
**Applies to:** #579 (export), #577 (voice), #578 (email), #692 (non-PII dump)
**Supersedes:** `2026-08-12-campaign-audit-log-design.md` on `spec/campaign-async-job-model` — that
draft predates all four implementations. Differences from it are called out inline.
**Status:** Design for review · **Date:** 2026-09-01

---

## 1. Purpose and boundary

An **append-only** log recording every action that **releases data**, on the **5W-2H** principle,
for DPDP accountability: who used which participants' data, what fields, when, where it went, why,
how, and how many.

It is deliberately **separate from the operational job tables**. `campaign_job` /
`campaign_job_item` are mutable, derive counts, and are subject to cleanup. This log is immutable
and outlives them — including the exported S3 object, which auto-deletes. The two are joined by
**`correlation_id = campaign_job.id`**.

Status polling reads the job tables. Compliance reads this log.

### What is audited, and what is not

The rule is **data release**, not API traffic — and not HTTP verb.

| Audited                                                             | Not audited                                         |
| ------------------------------------------------------------------- | --------------------------------------------------- |
| `POST /v1/campaign/export` — releases participant contact fields    | `GET /v1/campaign/{channel}/{job_id}` — status poll |
| `POST /v1/campaign/voice` — releases name/phone to Raya             | `GET /v1/campaign/{channel}` — job list             |
| `POST /v1/campaign/email` — releases addresses to the mail provider |                                                     |
| `GET /v1/campaign/dump` — releases the whole-network snapshot       |                                                     |

The dump is a `GET` and is audited; the status endpoints are `GET`s and are not. The distinction is
that the dump hands over data while the status routes return a job's own bookkeeping (status,
counts, item ids, skip reasons — no personal data).

Excluding the status routes is a deliberate decision with a second reason: clients are instructed to
poll every 5–10s until terminal, so a single export would generate 20–50 rows saying "someone
checked a job", burying the two rows that record an actual data release. Request-level traffic is
already captured by the structured request log (`requestId`, actor, route), which is the right home
for it.

> **Differs from the 2026-08-12 draft**, which predates the dump route and does not mention it.

---

## 2. Principles

- **Append-only.** Rows are inserted, never updated or deleted — the writer exposes no update,
  delete, or read. A campaign therefore produces **two rows** (`requested`, then `completed`)
  rather than one row that changes state; a dump produces **one** (§4).
- **Never stores participant PII values.** Field _names_ and counts only — never a participant
  name, email or phone. The only identities stored are **operators** (the coordinator, the
  export-link recipient).
- **Retained independently.** Survives the job rows and any exported artifact. Retention policy is
  out of scope here (see §9).
- **Best-effort writes.** An audit failure never fails a campaign. Gaps are detectable after the
  fact (§7).

---

## 3. Table `campaign_pii_audit`

One table, in the same database as `campaign_job`. Each row records **one event**, so a campaign
occupies two rows sharing a `correlation_id` — never one row that is updated in place.

| Group        | Columns                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| **key**      | `id uuid PK` · `correlation_id uuid NOT NULL` · `event` · `created_at timestamptz NOT NULL`                |
| **Who**      | `actor_user_id text` · `actor_org_id text` · `actor_azp text` · `recipient_ref text`                       |
| **What**     | `channel` · `pii_fields text[]` · `item_count int`                                                         |
| **When**     | `requested_at timestamptz` · `completed_at timestamptz`                                                    |
| **Where**    | `destination text` · `network text` · `instance text` · `request_ip text`                                  |
| **Why**      | `purpose text` · `consent_ref text`                                                                        |
| **How**      | `endpoint text` · `trace_id text` · `outcome` · `error_code text`                                          |
| **How many** | `requested_count int` · `resolved_count int` · `skipped_count int` · `failed_count int` · `sent_count int` |
| **meta**     | `details jsonb`                                                                                            |

**Enums**

- `event` — `requested` \| `completed`
- `channel` — `export` \| `voice` \| `email` \| `dump`
- `outcome` — `succeeded` \| `partial` \| `failed`. **NULL on `requested` rows.**

**Indexes** — `(actor_org_id, created_at)`, `(correlation_id)`, `(channel, created_at)`.

### `event` vs `outcome`

> **Differs from both the issue and the 2026-08-12 draft.** The issue lists `event` as
> `requested|completed` _plus_ a `status` of `queued|succeeded|partial|failed`; the draft lists
> `event` as `requested|completed|failed`. Both encode the outcome twice — a `failed` event and a
> `failed` status can disagree.

Resolved: **`event` is the phase, `outcome` is the result.** One fact, one column. `outcome` is
null on `requested` rows because at request time there is no outcome yet.

### Which fields each row carries

The worker **cannot** know `request_ip`, `actor_azp`, `endpoint` or the Keycloak `sub` — that
context dies with the HTTP request. So the two rows are deliberately asymmetric:

|          | `requested` (API)                               | `completed` (worker)                                            |
| -------- | ----------------------------------------------- | --------------------------------------------------------------- |
| Who      | all four fields                                 | `actor_org_id` only                                             |
| What     | `channel`, `pii_fields`, `item_count`           | `channel`                                                       |
| When     | `requested_at`                                  | `completed_at`                                                  |
| Where    | `network`, `instance`, `request_ip`, `endpoint` | `destination`                                                   |
| Why      | `purpose`, `consent_ref`                        | —                                                               |
| How      | `trace_id`                                      | `outcome`, `error_code`                                         |
| How many | `requested_count`                               | `resolved_count`, `skipped_count`, `failed_count`, `sent_count` |

`actor_org_id` appears on **both** rows on purpose. The worker gets it free — it already loads the
job, and the job carries `signalstack_org_id` — and it keeps _"everything org X did"_ a single
indexed scan instead of a self-join. The HTTP-only fields stay on the `requested` row and are
reached by joining on `correlation_id` when needed.

### Item ids are not stored

`item_count` and the outcome counts only. **Accepted limitation:** the log answers _"this org
exported 412 people's contact details on 1 Sep"_ but not _"was my data in that export?"_ — the
latter requires `campaign_job_item`, which is mutable and subject to cleanup.

> The issue offers `item_count (+ item_ids or a ref)`. Counts chosen: item ids are participant
> identifiers, and storing them would make this table more sensitive and sharpen its own retention
> question. Adding a column later is an additive migration if a concrete need appears.

### `pii_fields`

Derivable at **request** time for every channel, so the `requested` row is complete without waiting
for the worker:

| Channel | Value                                                                               |
| ------- | ----------------------------------------------------------------------------------- |
| export  | from `CAMPAIGN_EXPORT_FIELDS` — `contact` → `{name,email,phone}`; `full` → `{full}` |
| voice   | `{name,phone}` plus any `content.variables`                                         |
| email   | the placeholders actually used, via the existing `requiredContactFields()`          |
| dump    | `{}` — empty, asserting positively that no PII fields were released                 |

Empty rather than null for the dump: null reads as "unknown", `{}` reads as "none, and we checked".

---

## 4. The dump is a special shape

The dump breaks every assumption the campaign rows make, so it is stated rather than implied.

|               | campaign channels       | `dump`                     |
| ------------- | ----------------------- | -------------------------- |
| Phases        | async: request → worker | **synchronous** — one call |
| Identity      | coordinator, has an org | **system account, no org** |
| Participants  | items, counts           | none                       |
| Purpose       | from request `metadata` | none sent                  |
| Data released | participant PII         | allow-listed non-PII       |

**A dump produces one row, not two:** `event = 'completed'`, `channel = 'dump'`, `outcome =
succeeded|failed`.

- **`actor_org_id` is NULL, and that null is meaningful** — it is the signature of a whole-network
  access, which is the reason to audit the dump at all.
- `actor_user_id` = the service-account subject; `actor_azp` = the campaign-manager client.
- `item_count`, `purpose`, `recipient_ref` and the four outcome counts are NULL — none apply.
- `correlation_id` = a UUID generated per request. There is no `job_id` to borrow; the column stays
  non-null and still groups the row.
- `destination` = the bucket/prefix that was pre-signed.
- `details jsonb` = `{ "files": 3, "bytes": N }` — the dump's own "how many", reusing the existing
  column rather than adding dump-specific ones.

A distinct `event = 'accessed'` was considered and rejected: `channel = 'dump'` already
distinguishes these rows, and a third event value would complicate every query for no gain.

---

## 5. Package `packages/campaign-audit`

A **shared package** imported by both `apps/api` and `apps/worker`.

> `campaign_job` is currently reached through two hand-maintained twins —
> `apps/api/src/services/campaign-job-store/` and `apps/worker/src/services/campaign-job-client.ts`
> — which agree only because a conformance suite pins them. **#690 already tracks that duplication
> as debt.** Building the audit the same way would knowingly recreate it, in a table whose value
> depends on being trustworthy.

```
packages/campaign-audit/src/
  interface.ts   abstract CampaignAuditWriterBase + input types + Zod schemas
  postgres.ts    Drizzle-backed writer
  testing.ts     in-memory fake + build helpers
```

Follows `.claude/rules/interfaces.md`: abstract class (not a TS interface), every method returns
`Result<T, BaseError>`, `<Entity>Schema` naming, and a `./testing` subpath fake per
`.claude/rules/testing.md`.

### The interface is write-only — that is the append-only guarantee

```ts
export abstract class CampaignAuditWriterBase {
  abstract recordRequested(input: RequestedAudit): Promise<Result<void, BaseError>>;
  abstract recordCompleted(input: CompletedAudit): Promise<Result<void, BaseError>>;
  abstract recordDumpAccess(input: DumpAudit): Promise<Result<void, BaseError>>;
}
```

No update, no delete, no read. A caller cannot rewrite history because the vocabulary does not
exist. Per #617, immutability is enforced **at the DAL only** — database-level enforcement
(triggers or revoked grants) is deliberately out of scope, and interacts with retention (§9).

**Table definition** lives in `packages/db-schema/src/schema.ts` beside `campaign_job`, so both
apps share one definition.

**Migration is hand-authored.** `drizzle-kit db:generate` is broken repo-wide — the `exports` maps
of `@aggregator-dpg/db-schema` and `shared-primitives` lack a `require`/`default` condition (noted
in #698). Follow `0019`/`0020`: hand-write the `.sql`, update `meta/_journal.json` and the snapshot,
and **verify the applied shape against a real database** rather than trusting the migrations table
— that drift has bitten this table family before.

---

## 6. Write points

All three are existing single choke-points; no route needs to know about auditing individually.

| #   | Where                                                                   | Writes                                      |
| --- | ----------------------------------------------------------------------- | ------------------------------------------- |
| 1   | `apps/api/src/campaign/submit-job.ts` → `submitCampaignJob`             | `requested` — covers **all three** channels |
| 2   | `apps/worker/src/services/campaign-process/index.ts` → `runCampaignJob` | `completed`                                 |
| 3   | `apps/api/src/routes/campaign-dump.ts`                                  | the single dump row                         |

### Completion is written only on a terminal outcome

BullMQ retries mean `runCampaignJob` may execute several times for one job. A `completed` row is
written when the job reaches `completed`, `partial` or `failed` — **not** on a mid-sequence attempt
failure that will be retried. This mirrors the existing terminal-status guard in the orchestrator.

### Duplicates are preferred to gaps

A crash between writing the completion row and updating the job status could produce two completion
rows. This is accepted: in an append-only log a duplicate is recoverable on read (group by
`correlation_id`, `event`), whereas a gap is not. Deduping would require a read-then-write, which
the write-only interface forbids by design.

---

## 7. Failure handling

**Audit failures never fail a campaign.** Every call is wrapped; errors are caught and logged at
`error` level with `operation`, `correlation_id` and `channel`, and never rethrown.

**The ordering is what guarantees it.** The audit write happens _after_ the job row is committed and
enqueued:

1. `campaign_job` created and enqueued — the campaign is already durable and queued
2. the audit write is attempted
3. whatever the result — success, error, or timeout — the route returns `202`

By the time the audit is attempted, the campaign exists regardless. A total audit outage therefore
produces campaigns that run normally and an audit gap that §7's reconciliation query will surface —
never a failed or lost campaign. The same holds on the worker side: the completion row is written
after the job has already reached its terminal status.

> Neither #617 nor the 2026-08-12 draft addresses this. Decided here.

### API-side: awaited, with a bounded statement timeout

The insert is awaited — but capped by a short statement timeout (2s) so a pathological stall on this
table cannot hold an HTTP response open. Normal cost is ~1ms.

Awaiting rather than fire-and-forget because an un-awaited promise can be lost on process shutdown
and surfaces as an unhandled rejection. The timeout is what keeps "best effort" honest: worst case
the request is slightly slower, never failed.

The audit table shares a database with `campaign_job`, so a database-wide outage cannot introduce a
_new_ failure: `createJob` would already have failed and the request already returned 503. The
timeout covers the narrower case of something wrong with this table specifically.

### Reconciliation

Because `campaign_job` is the operational record, any gap is findable:

```sql
-- campaigns with no `requested` audit row
SELECT j.id, j.channel, j.status, j.created_at
FROM campaign_job j
LEFT JOIN campaign_pii_audit a
  ON a.correlation_id = j.id AND a.event = 'requested'
WHERE a.id IS NULL;
```

Documented as an operations query, not built as a job — YAGNI until gaps are shown to occur.

⚠️ The mirror check ("every `completed` row has a `requested` row") **must exclude
`channel = 'dump'`**, which legitimately has no `requested` row.

---

## 8. Testing

### The PII test is a property test, not a field-name check

The acceptance criterion is _"no participant PII value is ever written"_. Asserting the schema has
no `name` column proves only the schema. The realistic leak is an error message or a raw upstream
response landing in `details jsonb` with a participant's email inside it.

> Seed a fake Signals response whose participants carry distinctive values — `"Ananya Rao"`,
> `"ananya@example.org"`, `"+919876543210"`. Run a full campaign through the fake writer. Assert
> that **no audit row, serialised whole, contains any of those strings.**

### The rest

| Test                   | Asserts                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Conformance suite      | the in-memory fake and the Postgres writer behave identically (same pattern as `campaign-job-store`) |
| Lifecycle × 3 channels | exactly two rows, shared `correlation_id`, `requested` then `completed`                              |
| Dump                   | exactly **one** row; `actor_org_id` null; `pii_fields` empty                                         |
| Best-effort            | writer throws → the campaign still returns `202` and completes                                       |
| Terminal-only          | a job that fails mid-attempt and retries produces **one** completion row                             |
| `event`/`outcome`      | `outcome` is null on every `requested` row                                                           |

---

## 9. Out of scope

- **Retention policy.** #617 defers it. It interacts with database-level immutability (§5) — a
  retention delete needs a privileged path — so the two should be designed together, later.
- **Consent gating.** `consent_ref` exists and is nullable; consent storage and enforcement are
  specced separately.
- **Per-org audit access.** No API exposes this log. Compliance reads it directly. Adding a read
  API would require its own authorisation design and is not needed to close #617.
- **Database-level append-only enforcement.** DAL-only per #617; see §5.

---

## 10. Decisions on record

| Question                | Decision                               | Source                                |
| ----------------------- | -------------------------------------- | ------------------------------------- |
| Rows per campaign       | Two — `requested` + `completed`        | #617                                  |
| Audit write failure     | Best-effort, never blocks the campaign | decided here                          |
| API write sequencing    | Awaited, 2s statement timeout          | decided here                          |
| Item ids                | Count only                             | decided here                          |
| Dump                    | Audited; one row; `actor_org_id` null  | decided here                          |
| Status/list GETs        | **Not** audited — data release only    | decided here                          |
| Append-only enforcement | DAL only                               | #617                                  |
| Writer location         | Shared package, not api/worker twins   | decided here                          |
| `event` vs `status`     | `event` = phase, `outcome` = result    | resolves an issue/draft inconsistency |
