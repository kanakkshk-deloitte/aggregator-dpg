# Campaign Voice Channel (#577) — Design Spec

**Umbrella:** Blue-Dots-Economy/signals-dpg#237 · **Ticket:** aggregator-dpg#577
**Builds on:** the merged #602 async-job engine (on `feature`). **Status:** Design for review · **Date:** 2026-08-26

**Sources**
- Aryan's **Raya API — Campaign Trigger Integration** doc: https://docs.google.com/document/d/1303HhZPm4wZOcssfaux4LSmkvKfXkdGmyio2JSisfQ4/edit (mirror: `local_docs/Campaign Trigger Integration.pdf`).
- Raya live API via the `raya_voice` MCP (authoritative for payloads/responses).
- Base specs: `2026-08-12-campaign-api-contract-normalization-design.md`, `…-async-batch-processing-design.md`.

---

## 1. Purpose & responsibility boundary

Add a **voice** campaign channel on the #602 engine: a campaign-manager user selects owned participants and triggers outbound voice calls via a voice-bot provider (Raya first).

**Responsibility split (load-bearing):**

| Step | Owner |
| --- | --- |
| Select participants + agent, submit the voice request | Campaign manager |
| Authn/authz, ownership, resolve participant data server-side | **aggregator-dpg** |
| Execute the provider **operation** (v1: create batch + start) with the server-side key | **aggregator-dpg** |
| **Persist the provider responses** + expose them | **aggregator-dpg** |
| **Poll call outcomes/statuses** (Answered/Unanswered/…) | **Campaign manager**, directly against Raya (its own read key), using the batch id + `agent_args.ref`/phone Raya returns |

aggregator-dpg is a **fire-and-record dispatcher**: it performs the provider operation and records what the provider returned. It does **not** track call outcomes and runs **no reconciliation loop**.

## 2. Two axes of extensibility: provider × action

The design is built to grow along two independent axes, so the request payload and the port both carry them explicitly:

- **Provider** — which voice-bot vendor. Raya is the first and (for now) only adapter. Global config `CAMPAIGN_VOICE_PROVIDER` with a single supported value `raya`; the request MAY carry `provider` (defaults to config) so future multi-provider needs no contract change.
- **Action** — which provider operation. **v1 implements only `dispatch`** (= create batch + start). The shape reserves future actions — `stop` (stop a running batch), `update` (edit name/schedule/pace) — which operate on an existing prior voice job's batch id.

**`VoiceProvider` port (operation-oriented):**
- v1: `dispatch(input) → Result<VoiceDispatchResult>`
- future (declared, not implemented): `stop(batchRef) → Result<…>`, `update(batchRef, changes) → Result<…>`

The Raya adapter maps `dispatch` to its internal **two-step** (`POST /api/batch` → `POST /api/batch/{id}/start`); a `stop`/`update` later map to `POST /api/batch/{id}/stop` / `PATCH /api/batch/{id}`. The aggregator core (route, tables, dedup, worker, poll) is provider- and action-agnostic; only the adapter knows Raya.

## 3. Request contract

Shared envelope `{ item_ids, metadata, content }`. Voice `content`:

```jsonc
{
  "action": "dispatch",            // v1 only value; future: "stop" | "update"
  "provider": "raya",              // optional; defaults to CAMPAIGN_VOICE_PROVIDER
  "agent_id": "<provider agent id>",   // required for dispatch
  "batch_name": "KKB_Hindi_Day5",  // optional; defaults to "campaign-{job_id}"
  "variables": ["role", "location", "preferred_language"],  // optional item_state keys to pass to the agent; omit = pass all resolvable item_state fields
  // optional Raya start passthrough — forwarded as-is, NO server defaults:
  "schedule": { "timezone": "Asia/Kolkata", "start_time": "10:00", "end_time": "18:00", "days": [1,2,3,4,5] },
  "max_retries": 1,
  "retry_after_hrs": 4,
  "max_concurrent_calls": 5,
  "selected_statuses": ["Pending"]
}
```
`metadata` carries `purpose`/`consent` as elsewhere. `POST /v1/campaign/voice` → `202 { status, requested, job_id, message }`.

## 4. Contact variables — not just name/phone

The agent can be personalized with any participant data we hold, so we pass **more than name/phone**. Raya's create-batch accepts **arbitrary extra keys per contact** and stores them in `agent_args` for the agent to use.

- Decrypt each owned item for the **contact block** (`name`, `phone`) **and its `item_state`** (Signals `participant/decrypt`: `contact:['name','phone']` + `fields` = the `content.variables` list, or omit `fields` to get the full `item_state`).
- Build each Raya contact as: `{ contact_name, contact_phone, country_code?, ref: <item_id>, ...<selected item_state fields> }`. Scalar item_state values pass through directly; non-scalar values (arrays/objects) are **JSON-stringified**.
- **This depends on the Raya agent being configured to read those variables** — passing them is our capability; using them is the agent's config (owned by Aryan). Unused extras are harmless (stored, ignored).
- **PII:** these values (name/phone + item_state) are used only to build the provider request. They are **never persisted in our tables and never logged** (repo PII rule).

## 5. What we persist and expose (concrete, from the real Raya responses)

**Create-batch `200`** returns: `status`, `message`, `totalRows`, `validRows`, `invalidRows`, `batchId` (int), `contactsInserted`, `data[]` (opaque valid-contact echo), `errors[] { row, field, value, message }` (per-row, `row` = 1-based index into the contacts array we sent).
**Start-batch `200`** returns: `id` (batch id), `name`, `status`, `agent_id`, `created_at`, `schedule{…}`, `max_retries`, `concurrency`, `retry_after_hrs`, `total_contacts`, `completed_contacts`, `unanswered_contacts`.

We store:
- **Job level** — new nullable column `campaign_job.provider_response jsonb` holding the meaningful fields of both responses:
  `{ create: { status, message, totalRows, validRows, invalidRows, batchId, contactsInserted }, start: { id, status, total_contacts, completed_contacts, unanswered_contacts, schedule, max_retries, concurrency, retry_after_hrs } }`.
- **Item level** — `raya_batch_id` (= `batchId`, same across the job's items), item `status`, and `error_reason` for items whose row appears in create `errors[]` (mapped back by `row` index → `failed`). `provider_ref` is populated only if the provider returns a per-contact id (Raya's create `data[]` is opaque today, so typically null — the campaign manager correlates by `agent_args.ref`).
- **Exposure** — `GET /v1/campaign/voice/{job_id}` (reused poll route) returns job status + `provider_response` summary + per-item rows (status, `raya_batch_id`, `provider_ref`, error). The campaign manager reads the batch id from here and then polls Raya directly.

> `last_provider_status` (a #602 scaffold column) stays **unused** by voice — call statuses are the campaign manager's to poll.

## 6. Flow (async, on the #602 engine)

1. **API:** authenticate (azp + `signalstack_org_id`), validate envelope + voice `content` (require `agent_id` when `action:'dispatch'`), ingress rate-limit, active-job cap, `createJob(channel:'voice', items with action:'voice_call')`, enqueue, `202 {job_id}`.
2. **Worker (`voice` handler):**
   a. Skip items already `duplicate_active` (dedup, §7).
   b. Decrypt owned items for contact + item_state variables (§4); not-owned → `skipped_not_owned`; no phone → `skipped_no_contact`.
   c. `provider.dispatch({ agentRef, batchName, contacts, startOptions })` → Raya adapter does create + start (egress-gated, §7).
   d. Persist `provider_response`; mark accepted items `submitted` (+ `raya_batch_id`); map create `errors[].row` → those items `failed`.
   e. Provider failure → throw → BullMQ retry (retry-safe: an already-created batch / already-`submitted` item is not re-dispatched); final attempt marks leftover items `failed`.
3. **Done.** Roll-up → `completed`/`partial`/`failed`. No polling by us.

## 7. Reused engine behaviour (no new design)

- **Dedup:** items created with `action:'voice_call'` arm the existing `(item_id, action)` active-dedup index; a cross-job/cross-aggregator collision → `duplicate_active` (skipped, not a failure). *(#602 scaffolded this; the voice create path adds the code that produces `duplicate_active`.)*
- **Rate limiting:** per-org ingress cap (reused) + a **fail-closed egress gate** for Raya's ~1 call/20s on our create/start calls (honour `429 Retry-After`).
- **Retries:** per-channel BullMQ attempts + the engine's per-item terminal-status guard.

## 8. Non-goals & open items

**Non-goals:** call-outcome polling/reconciliation (campaign manager); `stop`/`update` actions (shape reserved, not built in v1); audit (#617, deferred); email + a second provider.

**Decisions & campaign-manager integration notes:**
1. **No server defaults (decided).** aggregator-dpg maintains **no defaults** for the Raya start fields (`max_concurrent_calls`, `selected_statuses`, `max_retries`, `retry_after_hrs`, `schedule`). The **campaign manager must supply** the ones it wants in `content`; we forward them verbatim. If a Raya-required field (`max_concurrent_calls`, `selected_statuses`) is omitted, Raya returns `400` and we record it as the job's failure reason — we neither inject nor validate defaults. *(Integration requirement for the campaign-manager team.)*
2. **Field names (decided):** use the live Raya request name **`max_concurrent_calls`**. Note for Aryan: the shared doc's start example says `concurrency`, which is the create/update + response field, not the start-request field.
3. **Non-scalar variables (decided):** JSON-stringify arrays/objects when placing them in the contact (→ `agent_args`).
