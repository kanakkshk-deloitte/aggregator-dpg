# Campaign Voice Channel (Raya) — Implementation Plan (#577)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `voice` campaign channel that dispatches outbound calls through a pluggable voice-bot provider (Raya first) on the merged #602 async-job engine — aggregator dispatches + records; the campaign manager polls the provider for call outcomes.

**Architecture:** Reuse the #602 engine (envelope, `campaign_job`/`campaign_job_item`, auth, poll route, dedup index, watchdog). Net-new: a provider-agnostic `VoiceProvider` port (Raya adapter first) covering an `action` axis (v1 = `dispatch` = create batch + start), a fail-closed Redis egress gate for Raya's ~1 call/20s, dedup-on-create that produces `duplicate_active`, a `runVoiceForJob` worker handler, full-`item_state`→`agent_args` variable passing, and `provider_response` capture. **No reconciliation** (outcome polling is the campaign manager's job).

**Tech Stack:** TypeScript, Fastify (apps/api), BullMQ + ioredis (apps/worker, packages/queue), Drizzle/Postgres (packages/db-schema), Zod, Vitest. Raya REST (`https://v1.getraya.app/api`, `X-API-Key`).

**Spec:** `docs/superpowers/specs/2026-08-26-campaign-voice-577-design.md`

## Global Constraints

- **Branch:** `feat/577-campaign-voice` off `feature` (this worktree). Work→`feature`.
- **Audit DEFERRED** — no audit events/tables (#617 untouched).
- **No server defaults (decided):** aggregator maintains **no** defaults for Raya start fields (`max_concurrent_calls`, `selected_statuses`, `max_retries`, `retry_after_hrs`, `schedule`). Forward verbatim what `content` supplies; a missing Raya-required field → Raya `400` recorded as the job's failure reason. Do NOT validate/inject them.
- **PII safety (`logging-observability.md`):** decrypted name/phone/`item_state` are used only to build the provider request — never persisted in our tables, never logged. No PII in any API response.
- **External-call rule (`error-handling.md`):** every Raya call has an explicit timeout + retry/backoff on transient (429/5xx/timeout) + honours `429 Retry-After` + returns typed `Result<T, BaseError>`.
- **Config discipline:** all tunables via `apps/*/src/config.ts` or package config; read once at boot.
- **Interfaces rule:** cross-package contract = `abstract class` with `./interface`+impls+`./testing`; `Result<T, BaseError>`.
- **Provider×action extensibility:** the aggregator core (route, tables, dedup, handler, poll) is provider- and action-agnostic; only the adapter knows Raya. v1 supports provider `raya` (global `CAMPAIGN_VOICE_PROVIDER`) and action `dispatch`.
- **Correlation:** each contact carries `ref = item_id`; Raya stores it in `agent_args` (confirmed) → the campaign manager correlates outcomes.

---

## File Structure

**New package** `packages/voice-provider/` (port + Raya adapter + egress + fake):
- `src/interface.ts` — `VoiceProviderBase` (abstract `dispatch`; `stop`/`update` declared as future no-ops) + DTO types.
- `src/raya.ts` — `RayaVoiceProvider` (create+start via HTTP, timeout/backoff/429, maps create `errors[].row`).
- `src/egress.ts` — `acquireRayaSlot()` fail-closed Redis window gate.
- `src/testing.ts` — `InMemoryVoiceProvider` fake.
- `src/index.ts` — `getVoiceProvider(cfg)` factory (selects by `provider` value).
- `package.json`/`tsconfig.json`/`vitest.config.ts` (subpath exports `.`/`./interface`/`./testing`).

**apps/api:**
- Create `src/campaign/voice-content.ts` (`voiceContentSchema`, `VoiceContent`).
- Create `src/routes/campaign-voice.ts`, `src/routes/campaign-voice.test.ts`.
- Modify `src/app.ts` (register), `src/config.ts` (`CAMPAIGN_VOICE_*`), `src/errors/codes.ts` (voice codes).
- Modify `src/services/campaign-job-store/{interface,postgres,memory}.ts` (dedup-on-create, `markSubmitted`, `setProviderResponse`, view fields) + `__tests__/conformance.ts`.
- Modify `src/routes/campaign-jobs.ts` (expose `raya_batch_id` + `provider_response`).

**apps/worker:**
- Create `src/services/campaign-process/voice.ts` + `voice.test.ts`.
- Create `src/services/voice-provider.ts` (`getVoiceProvider()` singleton + `RAYA_*` wiring).
- Modify `src/services/campaign-process/index.ts` (dispatch branch + `VoiceCollaborators`), `src/jobs/campaign-process.ts` (wire deps), `src/services/campaign-job-client.ts` (twin `markSubmitted`/`setProviderResponse`), `src/config.ts` (`RAYA_*`, `CAMPAIGN_VOICE_PROVIDER`).

**Migration:** `apps/api/drizzle/migrations/00XX_campaign_provider_response.sql` + snapshot; `packages/db-schema/src/schema.ts`.

---

## Task 1: Config knobs

**Files:** Modify `apps/api/src/config.ts`, `apps/worker/src/config.ts`; env templates. Test: extend the config test if present.

**Interfaces — Produces:** api `config.CAMPAIGN_VOICE_{MAX_ITEMS,SUBMIT_WINDOW_SECONDS,SUBMIT_MAX,MAX_ACTIVE_PER_ORG,ATTEMPTS}`; worker `config.{CAMPAIGN_VOICE_PROVIDER,RAYA_BASE_URL,RAYA_API_KEY,RAYA_TIMEOUT_MS,RAYA_EGRESS_WINDOW_SECONDS,RAYA_EGRESS_MAX}`.

- [ ] **Step 1: api knobs** — mirror the `CAMPAIGN_EXPORT_*` block:

```ts
  CAMPAIGN_VOICE_MAX_ITEMS: z.coerce.number().int().positive().default(500),
  CAMPAIGN_VOICE_SUBMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  CAMPAIGN_VOICE_SUBMIT_MAX: z.coerce.number().int().positive().default(10),
  CAMPAIGN_VOICE_MAX_ACTIVE_PER_ORG: z.coerce.number().int().positive().default(3),
  CAMPAIGN_VOICE_ATTEMPTS: z.coerce.number().int().positive().default(3),
```

- [ ] **Step 2: worker knobs**

```ts
  CAMPAIGN_VOICE_PROVIDER: z.enum(['raya']).default('raya'),
  RAYA_BASE_URL: z.string().url().default('https://v1.getraya.app/api'),
  RAYA_API_KEY: z.string().min(1).optional(),   // asserted lazily when the voice provider runs
  RAYA_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  RAYA_EGRESS_WINDOW_SECONDS: z.coerce.number().int().positive().default(20),
  RAYA_EGRESS_MAX: z.coerce.number().int().positive().default(1),
```
> No knob for the Raya start fields — they are pure passthrough, never defaulted here.

- [ ] **Step 3: env templates** — add the keys with comments to `apps/api/.env.example`, `apps/worker/.env.example`, `infra/env.template`.
- [ ] **Step 4: Typecheck** — Run: `pnpm --filter @aggregator-dpg/api typecheck && pnpm --filter @aggregator-dpg/worker typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(campaign-voice): config knobs (voice caps + Raya client)"`

---

## Task 2: Migration — `campaign_job.provider_response`

**Files:** Modify `packages/db-schema/src/schema.ts`; generate `apps/api/drizzle/migrations/00XX_campaign_provider_response.sql` + snapshot. Test: `packages/db-schema/src/__tests__/campaign-job.schema.test.ts`.

**Interfaces — Produces:** `campaignJob.providerResponse: jsonb | null`.

- [ ] **Step 1: Failing schema test** — assert the column exists:

```ts
it('campaign_job has a nullable provider_response jsonb', () => {
  const cols = getTableColumns(campaignJob);
  expect(cols.providerResponse).toBeDefined();
});
```

- [ ] **Step 2: Run — fail** — Run: `pnpm --filter @aggregator-dpg/db-schema test` — Expected: FAIL.
- [ ] **Step 3: Add column** — in `schema.ts` `campaignJob`: `providerResponse: jsonb('provider_response')` (nullable, no default). Comment: "voice: raw create+start provider responses, captured for the campaign manager".
- [ ] **Step 4: Generate migration** — Run: `pnpm --filter @aggregator-dpg/api db:generate` (Drizzle). Verify the generated SQL is a single additive `ALTER TABLE "campaign_job" ADD COLUMN "provider_response" jsonb;` and a matching snapshot. Do NOT hand-edit.
- [ ] **Step 5: Run — pass** — Run: `pnpm --filter @aggregator-dpg/db-schema test` — Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -am "feat(campaign-voice): add campaign_job.provider_response column"`

---

## Task 3: `packages/voice-provider` — port + types + fake + egress

**Files:** Create the package (see File Structure). Tests: `src/__tests__/{testing,egress}.test.ts`.

**Interfaces — Produces:**
- `abstract class VoiceProviderBase { dispatch(i: VoiceDispatchInput): Promise<Result<VoiceDispatchResult, BaseError>>; }` (+ `stop`/`update` declared returning `err(NotImplemented)` in the base for now).
- `VoiceContact { ref: string; name: string; phone: string; countryCode?: string; variables: Record<string, string> }`
- `VoiceDispatchInput { agentRef: string; batchName: string; contacts: VoiceContact[]; startOptions: Record<string, unknown> }`
- `VoiceDispatchResult { providerBatchRef: string; accepted: string[]; rejected: { ref: string; error: string }[]; providerResponse: { create: unknown; start: unknown } }`
- `class InMemoryVoiceProvider extends VoiceProviderBase` (records dispatches; `setReject(ref, msg)` to simulate per-row rejection).
- `acquireRayaSlot(deps): Promise<void>` (fail-closed; from Task 3b below — keep in this package).

- [ ] **Step 1: Scaffold** — copy `packages/_template` → `packages/voice-provider`, name `@aggregator-dpg/voice-provider`, subpath exports `.`/`./interface`/`./testing`.
- [ ] **Step 2: Failing fake test** — `__tests__/testing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryVoiceProvider } from '../testing.js';

it('dispatch returns a providerBatchRef and accepts all contacts by default', async () => {
  const p = new InMemoryVoiceProvider();
  const r = await p.dispatch({ agentRef: 'a', batchName: 'b',
    contacts: [{ ref: 'i1', name: 'A', phone: '9000000001', variables: { role: 'Electrician' } }],
    startOptions: { max_concurrent_calls: 5, selected_statuses: ['Pending'] } });
  expect(r.success).toBe(true);
  if (!r.success) return;
  expect(r.value.providerBatchRef).toBeTruthy();
  expect(r.value.accepted).toEqual(['i1']);
});

it('reports a per-row rejection', async () => {
  const p = new InMemoryVoiceProvider();
  p.setReject('i1', 'invalid phone');
  const r = await p.dispatch({ agentRef: 'a', batchName: 'b',
    contacts: [{ ref: 'i1', name: 'A', phone: 'x', variables: {} }], startOptions: {} });
  if (!r.success) throw new Error('expected ok envelope');
  expect(r.value.rejected).toEqual([{ ref: 'i1', error: 'invalid phone' }]);
});
```

- [ ] **Step 3: Run — fail** — Run: `pnpm --filter @aggregator-dpg/voice-provider test` — Expected: FAIL.
- [ ] **Step 4: Write `interface.ts` + `testing.ts`** per the Produces block.
- [ ] **Step 5: Egress test** — `__tests__/egress.test.ts`: (a) first slot immediate, second within window waits (assert injected `sleep` called); (b) redis error → sleeps a full `windowSeconds*1000` then proceeds (fail-closed). (Copy the exact tests from the egress design in the spec's §7.)
- [ ] **Step 6: Write `egress.ts`** — fixed-window `INCR`+`EXPIRE` on `raya:egress:{windowStart}`; if count ≤ max return; else sleep to next boundary and retry; **on redis error `await sleep(windowSeconds*1000)` then return** (fail-closed).
- [ ] **Step 7: Run — pass** — Run: `pnpm --filter @aggregator-dpg/voice-provider test` — Expected: PASS.
- [ ] **Step 8: Commit** — `git commit -am "feat(voice-provider): port, types, in-memory fake, fail-closed egress gate"`

---

## Task 4: `RayaVoiceProvider` adapter (create + start)

**Files:** Create `packages/voice-provider/src/raya.ts`; `src/index.ts` factory. Test: `src/__tests__/raya.test.ts`.

**Interfaces — Consumes:** `VoiceProviderBase` + types; `acquireRayaSlot`. **Produces:** `class RayaVoiceProvider extends VoiceProviderBase; constructor(opts: { baseUrl; apiKey; timeoutMs?; maxAttempts?; acquireSlot: () => Promise<void>; fetchImpl?: typeof fetch })`; `getVoiceProvider(cfg): VoiceProviderBase`.

- [ ] **Step 1: Failing test** — stub `fetch`: create returns `{status:'success', batchId:42, totalRows:1, validRows:1, invalidRows:0, contactsInserted:1}`, start returns `{id:42,status:'Active',total_contacts:1}`. Assert:
  - two calls made, both preceded by `acquireSlot`;
  - create body contacts carry `contact_name`,`contact_phone`, `ref`, and each `variables` key flattened into the contact;
  - start body contains only the `startOptions` keys supplied (no injected defaults);
  - result `{ providerBatchRef:'42', accepted:['i1'], rejected:[], providerResponse:{create,start} }`;
  - a create response with `errors:[{row:1,field:'contact_phone',message:'bad'}]` → `rejected:[{ref:'i1',error:'bad'}]`, `accepted:[]`, and **start is not called** if nothing accepted;
  - 429 then success retried honouring `Retry-After`; 401 → `AuthError`, no retry.

- [ ] **Step 2: Run — fail** — Run: `pnpm --filter @aggregator-dpg/voice-provider test raya` — Expected: FAIL.
- [ ] **Step 3: Implement `raya.ts`** — model HTTP retry/timeout/typed-error on `packages/signalstack-writer/src/http.ts`. `dispatch()`:
  1. `await acquireSlot()`; `POST {baseUrl}/batch` with `{ agent_id: agentRef, batch_name: batchName, contacts: contacts.map(c => ({ contact_name: c.name, contact_phone: c.phone, ...(c.countryCode?{country_code:c.countryCode}:{}), ref: c.ref, ...c.variables })) }`.
  2. Parse `batchId` (→ String), map `errors[].row` (1-based) back to `contacts[row-1].ref` → `rejected`; `accepted` = the rest.
  3. If `accepted.length === 0` → return `ok({ providerBatchRef, accepted:[], rejected, providerResponse:{create, start:null} })` (skip start).
  4. Else `await acquireSlot()`; `POST {baseUrl}/batch/{batchId}/start` with **only** the present `startOptions` keys (spread as-is; omit undefined). Parse start response.
  5. Return `ok({ providerBatchRef, accepted, rejected, providerResponse:{ create:<summary>, start:<summary> } })`.
  Error mapping: 401→`AuthError` (no retry); other 4xx→`ValidationError` (no retry, surfaced as job failure); 429/5xx/network→retry w/ backoff honouring `Retry-After`; on exhausted → `UpstreamError`.
- [ ] **Step 4: `index.ts` factory** — `getVoiceProvider(cfg: { provider: 'raya'; baseUrl; apiKey; timeoutMs; acquireSlot })` → `switch(cfg.provider){ case 'raya': return new RayaVoiceProvider(...) }`.
- [ ] **Step 5: Run — pass** — Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -am "feat(voice-provider): Raya adapter (create+start, egress-gated, error mapping)"`

---

## Task 5: Store — dedup-on-create + provider writers + view fields

**Files:** Modify `campaign-job-store/{interface,postgres,memory}.ts` + `__tests__/conformance.ts`; twin `apps/worker/src/services/campaign-job-client.ts`.

**Interfaces — Produces (add to `CampaignJobStoreBase` + twin):**
- `markSubmitted(jobId, itemId, args: { rayaBatchId: string; providerRef?: string }): Promise<StoreResult<void>>` (status `submitted` + `raya_batch_id`).
- `setProviderResponse(jobId, response: unknown): Promise<StoreResult<void>>` (writes `provider_response`).
- `JobItemView` gains `rayaBatchId: string | null`; `JobView` gains `providerResponse: unknown | null`.
- `createJob`: an item with non-null `action` already active (`pending|resolved|submitted`) for the same `(item_id, action)` in ANY job → new row created `duplicate_active` (not `pending`); null-action (export) unchanged.

- [ ] **Step 1: Conformance tests** — dedup (`duplicate_active` for a second active `(item_id,'voice_call')` in the same org; null-action stays `pending`), and `markSubmitted`+`setProviderResponse` round-trip (item `submitted`+`rayaBatchId`; job `providerResponse` readable via `getJob`). (Ensure the dedup test reuses one org across both jobs.)
- [ ] **Step 2: Run — fail** — Run: `pnpm --filter @aggregator-dpg/api test campaign-job-store` — Expected: FAIL.
- [ ] **Step 3: `interface.ts`** — add the two methods + the view fields.
- [ ] **Step 4: `postgres.ts`** — (a) `createJob`: when any item has non-null action, `SELECT item_id FROM campaign_job_item WHERE action=$a AND item_id = ANY($ids) AND status IN ('pending','resolved','submitted')`; insert non-dup ids `pending`, dup ids `duplicate_active`, in the same tx; on `23505` during the fresh insert (race), reclassify that id as dup and retry once. (b) `markSubmitted`: `UPDATE … SET status='submitted', raya_batch_id=$b, provider_ref=coalesce($ref,provider_ref), updated_at=now() WHERE job_id=$j AND item_id=$i AND status NOT IN (<terminal>)`. (c) `setProviderResponse`: `UPDATE campaign_job SET provider_response=$r, updated_at=now() WHERE id=$j`. (d) map `raya_batch_id`→`JobItemView.rayaBatchId`, `provider_response`→`JobView.providerResponse`.
- [ ] **Step 5: `memory.ts`** — mirror.
- [ ] **Step 6: twin `campaign-job-client.ts`** — add `markSubmitted`, `setProviderResponse`.
- [ ] **Step 7: Run — pass** — Run: `pnpm --filter @aggregator-dpg/api test campaign-job-store && pnpm --filter @aggregator-dpg/worker test campaign-job-client` — Expected: PASS.
- [ ] **Step 8: Commit** — `git commit -am "feat(campaign-voice): store dedup-on-create + provider-response writers + view fields"`

---

## Task 6: Voice `content` schema

**Files:** Create `apps/api/src/campaign/voice-content.ts` + `.test.ts`.

**Interfaces — Produces:** `voiceContentSchema`, `type VoiceContent`, `voiceStartOptions(c): Record<string, unknown>` (the passthrough object, present keys only).

- [ ] **Step 1: Failing test** — `agent_id` required for `action:'dispatch'`; `action` defaults `'dispatch'` and only `'dispatch'` accepted in v1 (others → error); `provider` optional; unknown top-level keys rejected; `voiceStartOptions` returns only supplied passthrough keys (no injected defaults); `variables` optional string[].
- [ ] **Step 2: Run — fail** — Expected: FAIL.
- [ ] **Step 3: Implement**

```ts
import { z } from 'zod';

export const voiceContentSchema = z.object({
  action: z.enum(['dispatch']).default('dispatch'),
  provider: z.enum(['raya']).optional(),
  agent_id: z.string().min(1),
  batch_name: z.string().min(1).max(200).optional(),
  variables: z.array(z.string().min(1)).optional(),
  // Raya start passthrough — forwarded verbatim, never defaulted:
  schedule: z.record(z.unknown()).optional(),
  max_retries: z.number().int().nonnegative().optional(),
  retry_after_hrs: z.number().nonnegative().optional(),
  max_concurrent_calls: z.number().int().positive().optional(),
  selected_statuses: z.array(z.string()).optional(),
}).strict();
export type VoiceContent = z.infer<typeof voiceContentSchema>;

const START_KEYS = ['schedule','max_retries','retry_after_hrs','max_concurrent_calls','selected_statuses'] as const;
export function voiceStartOptions(c: VoiceContent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of START_KEYS) if (c[k] !== undefined) out[k] = c[k];
  return out;
}
```

- [ ] **Step 4: Run — pass** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(campaign-voice): voice content schema + start-options passthrough"`

---

## Task 7: Voice API route

**Files:** Create `apps/api/src/routes/campaign-voice.ts` + `.test.ts`; modify `app.ts`, `errors/codes.ts`.

**Interfaces — Produces:** `registerCampaignVoiceRoutes(app): Promise<void>` mounting `POST /v1/campaign/voice`.

- [ ] **Step 1: Failing route test** — copy `campaign-export.test.ts` structure. Assert: valid body (`content.agent_id`) → `202 {status,requested,job_id}` and `createJob` called with `channel:'voice'`, `content` stored, items `action:'voice_call'`; missing `agent_id` → `400`; `action:'stop'` → `400` (unsupported in v1); over `CAMPAIGN_VOICE_MAX_ITEMS` → `400`; bad `azp` → `401`; no `signalstack_org_id` → `403`; `consume` `!allowed` → `429`.
- [ ] **Step 2: Run — fail** — Run: `pnpm --filter @aggregator-dpg/api test campaign-voice` — Expected: FAIL.
- [ ] **Step 3: Implement `campaign-voice.ts`** — mirror `campaign-export.ts`; differences: parse `content` with `voiceContentSchema`; `namespace:'campaign-submit-voice'` + `CAMPAIGN_VOICE_SUBMIT_*`; `countActiveJobs(orgId,'voice')` vs `CAMPAIGN_VOICE_MAX_ACTIVE_PER_ORG`; `createJob({ ..., channel:'voice', content, items: itemIds.map(id => ({ itemId:id, action:'voice_call' })) })`; enqueue `attempts: config.CAMPAIGN_VOICE_ATTEMPTS`; reuse the `needsEnqueue`/replay + `enqueue_failed` compensation + `202`. Add `VOICE_ENQUEUE_FAILED` + `CAMPAIGN_VOICE_TOO_MANY_ITEMS` to `errors/codes.ts`.
- [ ] **Step 4: Register in `app.ts`** — `await registerCampaignVoiceRoutes(app); await registerCampaignJobRoutes(app, 'voice');`
- [ ] **Step 5: Run — pass** — Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -am "feat(campaign-voice): POST /v1/campaign/voice route"`

---

## Task 8: Worker voice handler

**Files:** Create `apps/worker/src/services/campaign-process/voice.ts` + `.test.ts`, `apps/worker/src/services/voice-provider.ts`; modify `campaign-process/index.ts`, `jobs/campaign-process.ts`.

**Interfaces — Consumes:** `CampaignJobClient` (+ `markSubmitted`/`setProviderResponse`), `VoiceProviderBase`, `fetchDecryptedProfiles`. **Produces:** `runVoiceForJob(job, deps)`; `VoiceCollaborators { fetchDecryptedProfiles; provider: VoiceProviderBase }` on `CampaignJobDeps`; `getVoiceProvider()` singleton.

- [ ] **Step 1: Failing handler test** — voice harness (mirror `campaign-process/index.test.ts`) with in-memory `client` (new writers), `InMemoryVoiceProvider`, and a `fetchDecryptedProfiles` fake returning `contact.name/phone` + an `item_state` (e.g. `{ role:'Electrician', langs:['hi','en'] }`). For a 2-item job assert:
  - decrypt requested with `contact:['name','phone']` and `fields` = `content.variables` (or omitted → all);
  - owned items with phone → contacts built with `ref=item_id`, name, phone, and `variables` incl. `role:'Electrician'` and `langs` **JSON-stringified**;
  - not-owned → `skipped_not_owned`; owned-but-no-phone → `skipped_no_contact`;
  - `provider.dispatch` called once; accepted items → `markSubmitted(rayaBatchId, ...)`; rejected refs → `markItem(..., 'failed', <error>)`;
  - `setProviderResponse(job.id, providerResponse)` called;
  - `duplicate_active` items are skipped (never decrypted/dispatched);
  - retry-safety: an item already `submitted` (or a job whose items already have `raya_batch_id`) is not re-dispatched;
  - provider `err(...)` → throws (retryable); final attempt marks leftover items `failed`.
- [ ] **Step 2: Run — fail** — Run: `pnpm --filter @aggregator-dpg/worker test campaign-process/voice` — Expected: FAIL.
- [ ] **Step 3: Implement `voice.ts`**:
  1. Decrypt owned items (chunked by `config.decryptChunk`) with `{ contact:['name','phone'], fields: content.variables /* undefined = all item_state */ }`; mark `resolved`/`skipped_not_owned`; skip items already `duplicate_active`/terminal; `heartbeat` per chunk.
  2. Build `contacts`: for each resolved item with a non-empty phone → `{ ref: itemId, name, phone, countryCode?, variables: flatten(item_state) }` where `flatten` stringifies non-scalars (arrays/objects → `JSON.stringify`) and drops nullish; items without phone → `markItem(..., 'skipped_no_contact', 'no_phone')`.
  3. If no contacts → return.
  4. `const res = await deps.voice.provider.dispatch({ agentRef: content.agent_id, batchName: content.batch_name ?? 'campaign-'+job.id, contacts, startOptions: voiceStartOptions(content) })`; on `!res.success` → throw.
  5. `await deps.client.setProviderResponse(job.id, res.value.providerResponse)`; for each accepted ref → `markSubmitted(job.id, ref, { rayaBatchId: res.value.providerBatchRef })`; for each rejected → `markItem(job.id, ref, 'failed', error)`.
  6. Return. Roll-up handles job status. **No polling.**
  Retry-safety guard at top: if any item already has `raya_batch_id`, the batch was created on a prior attempt — do not create a second one (resume: only re-run the mark/persist for the known batch, or no-op if already submitted).
- [ ] **Step 4: Dispatch branch** — `index.ts`: `else if (job.channel === 'voice') { await runVoiceForJob(job, deps); }`; add `voice?: VoiceCollaborators` to `CampaignJobDeps`.
- [ ] **Step 5: Wire deps** — `jobs/campaign-process.ts`: add `voice: { fetchDecryptedProfiles: q => ss.fetchDecryptedProfiles(q), provider: getVoiceProvider() }`. `services/voice-provider.ts`: `getVoiceProvider()` singleton building `RayaVoiceProvider` from `config.RAYA_*` with `acquireSlot: () => acquireRayaSlot({ redis: getRedis(), windowSeconds: config.RAYA_EGRESS_WINDOW_SECONDS, max: config.RAYA_EGRESS_MAX })`; throw `ConfigError` if `RAYA_API_KEY` unset (lazy, like `getSignalStackWriter()`).
- [ ] **Step 6: Run — pass** — Run: `pnpm --filter @aggregator-dpg/worker test campaign-process` — Expected: PASS.
- [ ] **Step 7: Commit** — `git commit -am "feat(campaign-voice): worker dispatch handler (decrypt + provider dispatch + persist)"`

---

## Task 9: Poll surface + full verification

**Files:** Modify `apps/api/src/routes/campaign-jobs.ts` + `campaign-jobs.test.ts`.

- [ ] **Step 1: Failing test** — `GET /v1/campaign/voice/:job_id` returns item rows with `raya_batch_id` and the job's `provider_response`.
- [ ] **Step 2: Implement** — extend the item projection with `raya_batch_id` (from `JobItemView.rayaBatchId`) and add `provider_response` to the job projection (from `JobView.providerResponse`).
- [ ] **Step 3: Run — pass** — Run: `pnpm --filter @aggregator-dpg/api test campaign-jobs` — Expected: PASS.
- [ ] **Step 4: Full gates** — Run: `pnpm -w typecheck && pnpm -w test && pnpm dep-check` — Expected: PASS. Fix any dependency-cruiser breaks (import `@aggregator-dpg/voice-provider` only via subpaths).
- [ ] **Step 5: Commit** — `git commit -am "feat(campaign-voice): expose raya_batch_id + provider_response on job poll"`

---

## Self-Review

**Spec coverage:**
- Responsibility boundary (dispatch+record, no reconciliation) → Tasks 8–9; no reconcile task exists. ✓
- Provider×action port (dispatch v1; stop/update declared) → Tasks 3–4. ✓
- Envelope + voice `content` (action/provider/agent_id/batch_name/variables/passthrough) → Task 6. ✓
- Full `item_state`→`agent_args`, stringify non-scalars → Task 8 step 3. ✓
- No server defaults for start fields → Tasks 1, 6 (`voiceStartOptions` present-keys-only), 4 (adapter omits undefined). ✓
- `provider_response` capture + per-item error mapping (create `errors[].row`) → Tasks 2, 4, 5, 8. ✓
- Dedup ON → `duplicate_active` produced on create → Task 5. ✓
- Egress fail-closed + 429 Retry-After → Tasks 3, 4. ✓
- Poll exposes `raya_batch_id` + `provider_response` → Task 9. ✓
- Audit deferred → no audit tasks. ✓
- Ownership (azp + `signalstack_org_id` + participant/decrypt scope) → reused, asserted Task 7. ✓

**Placeholder scan:** none — the `00XX` migration number is resolved by `db:generate` in Task 2 step 4.

**Type consistency:** `markSubmitted`/`setProviderResponse`/`JobItemView.rayaBatchId`/`JobView.providerResponse` defined in Task 5, consumed in Tasks 8–9; `VoiceDispatchInput`/`Result` defined Task 3, produced by the adapter Task 4, consumed Task 8; `voiceStartOptions` defined Task 6, used Task 8; `VoiceCollaborators` defined and consumed Task 8.

**Scope:** one cohesive subsystem (voice channel), no reconciliation, single provider — appropriately sized for one plan.
