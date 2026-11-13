# Campaign PII Export API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /v1/campaign/export` to aggregator-dpg — an async, fire-and-forget endpoint that decrypts a set of owned Signals items, writes a CSV to private S3, and emails a short-lived pre-signed download link to a configured network admin.

**Architecture:** A thin Fastify route validates an interim `x-org-id` header + body, then kicks off an **un-awaited** background orchestrator `runExport(params, deps)`. The orchestrator resolves PII via the existing `signalstack-writer.fetchDecryptedProfiles` (ownership enforced Signals-side by `onboarded_by`), reuses `buildDecryptedProfilesCsv`, uploads via the existing `object-storage` service, presigns a GET URL, and emails the link with the aggregator's own mailer. Deps are injected so the orchestrator is unit-testable with fakes.

**Tech Stack:** TypeScript (ESM), Fastify + `fastify-type-provider-zod`, Zod, Vitest, AWS S3 SDK, existing `@aggregator-dpg/signalstack-writer`.

## Global Constraints

- **Design doc:** `docs/superpowers/specs/2026-08-07-campaign-pii-export-design.md` — the authority for scope. Interim/prototype-grade.
- **Interim auth only:** `x-org-id` header carries the caller's **Signals org id**, passed straight through as `actingOrgId`. No token, no shared secret. Ownership is enforced by Signals decrypt scoping. Must not ship to prod without KC token (#576).
- **PII discipline:** never log `item_state`, PII, or the presigned URL. Logs carry counts + S3 key only. (`.claude/rules/logging-observability.md`)
- **Error rules:** external calls keep timeout + retry + typed errors; no empty catch. (`.claude/rules/error-handling.md`)
- **Route convention:** routes never throw raw — throw `httpError('CODE')`; the global error handler renders the envelope. Zod body rejection auto-renders `400 SCHEMA_VALIDATION`.
- **Files are camelCase-free / repo style:** follow existing `apps/api` patterns exactly (snake_case DB, kebab route files, `registerXRoutes(app)`).
- **Testing:** Vitest, fakes over mocks, no real network/S3 in unit tests, ≥ 70% line coverage. Commit with Conventional Commits; do not bypass hooks with `--no-verify`.
- **Env vars added in `config.ts` only** (Zod `ConfigSchema` or a live-env getter beside `supportEmail()`).

---

## File Structure

- `apps/api/src/config.ts` (modify) — add `EXPORT_MAX_ITEM_IDS`, `EXPORT_URL_TTL_SECONDS` to `ConfigSchema`; add `exportNetworkAdminEmail()` getter.
- `apps/api/src/errors/codes.ts` (modify) — add `EXPORT_NOT_CONFIGURED` (503), `MISSING_ORG_ID` (401).
- `apps/api/src/services/object-storage/index.ts` (modify) — add `signExportDownloadUrl(key)`.
- `apps/api/src/services/object-storage/index.test.ts` (modify) — add a presign test + `EXPORT_URL_TTL_SECONDS` to the mock config.
- `apps/api/src/services/campaign-export/index.ts` (create) — `runExport(params, deps)` orchestrator + `renderExportEmail` + exported types.
- `apps/api/src/services/campaign-export/index.test.ts` (create) — orchestrator unit tests.
- `apps/api/src/routes/campaign-export.ts` (create) — the route + `x-org-id` handling + Zod body + 202.
- `apps/api/src/routes/campaign-export.test.ts` (create) — route sync-contract tests.
- `apps/api/src/app.ts` (modify) — import + register the new route group.

---

## Task 1: Foundations — config, error codes, S3 export presign

**Files:**

- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/errors/codes.ts`
- Modify: `apps/api/src/services/object-storage/index.ts`
- Test: `apps/api/src/services/object-storage/index.test.ts`

**Interfaces:**

- Produces:
  - `config.EXPORT_MAX_ITEM_IDS: number` (default `500`)
  - `config.EXPORT_URL_TTL_SECONDS: number` (default `3600`)
  - `exportNetworkAdminEmail(): string | undefined`
  - `ERR.EXPORT_NOT_CONFIGURED` (status 503), `ERR.MISSING_ORG_ID` (status 401)
  - `signExportDownloadUrl(key: string): Promise<SignedDownloadUrl>` where `SignedDownloadUrl = { url: string; key: string; expiresAt: string }` (already exported from object-storage)

- [ ] **Step 1: Write the failing test** (append inside the top-level `describe('object-storage', …)` block in `apps/api/src/services/object-storage/index.test.ts`)

```typescript
describe('signExportDownloadUrl', () => {
  it('signs a GET url with the export TTL and csv attachment disposition', async () => {
    mockConfig = { ...baseConfig, EXPORT_URL_TTL_SECONDS: 3600 };
    getSignedUrlMock.mockResolvedValue('https://signed.example/export.csv');
    const { signExportDownloadUrl } = await import('./index.js');

    const res = await signExportDownloadUrl('campaign-exports/org-1/2026.csv');

    expect(res).toMatchObject({
      url: 'https://signed.example/export.csv',
      key: 'campaign-exports/org-1/2026.csv',
    });
    expect(typeof res.expiresAt).toBe('string');
    // GetObjectCommand built for a csv download
    const cmd = getSignedUrlMock.mock.calls[0]![1] as { input: Record<string, unknown> };
    expect(cmd.input).toMatchObject({
      Bucket: 'aggregator-bulk-uploads',
      Key: 'campaign-exports/org-1/2026.csv',
      ResponseContentType: 'text/csv',
    });
    // export TTL forwarded to the presigner
    expect(getSignedUrlMock.mock.calls[0]![2]).toMatchObject({ expiresIn: 3600 });
  });
});
```

Also add `EXPORT_URL_TTL_SECONDS: 3600` to the `baseConfig` object near the top of that test file (beside `QR_DOWNLOAD_URL_TTL_SECONDS`), so other tests importing the module keep a valid config shape.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/api test -- src/services/object-storage/index.test.ts -t "signExportDownloadUrl"`
Expected: FAIL — `signExportDownloadUrl` is not exported.

- [ ] **Step 3a: Add the config vars.** In `apps/api/src/config.ts`, inside the `ConfigSchema = z.object({ … })`, add these two lines next to `QR_DOWNLOAD_URL_TTL_SECONDS`:

```typescript
  EXPORT_MAX_ITEM_IDS: z.coerce.number().int().positive().default(500),
  EXPORT_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
```

- [ ] **Step 3b: Add the network-admin getter.** In `apps/api/src/config.ts`, directly below the existing `supportEmail()` function, add:

```typescript
/**
 * Recipient(s) of the participant-export download link (network admin).
 * Comma-separated env, normalised like {@link supportEmail}. Read live on
 * each request so an operator can change it without a restart. Unset ⇒ the
 * export endpoint reports `EXPORT_NOT_CONFIGURED`.
 */
export function exportNetworkAdminEmail(): string | undefined {
  return normaliseEmailList(process.env.EXPORT_NETWORK_ADMIN_EMAIL);
}
```

- [ ] **Step 3c: Add the error codes.** In `apps/api/src/errors/codes.ts`, add two entries inside the `ERR` object (place them after the existing `SCHEMA_VALIDATION` entry):

```typescript
  MISSING_ORG_ID: {
    code: 'MISSING_ORG_ID',
    status: 401,
    title: 'Missing organisation id',
    detail: 'The x-org-id header is required.',
    hint: 'Interim auth: the caller must send x-org-id (Signals org id) until the KC token model (#576) lands.',
  },
  EXPORT_NOT_CONFIGURED: {
    code: 'EXPORT_NOT_CONFIGURED',
    status: 503,
    title: 'Export not available',
    detail: 'Participant export is not configured on this instance.',
    hint: 'EXPORT_NETWORK_ADMIN_EMAIL and/or the signalstack writer are unset. Check env (SIGNALSTACK_BASE_URL, SIGNALSTACK_ADMIN_KEY, EXPORT_NETWORK_ADMIN_EMAIL).',
  },
```

- [ ] **Step 3d: Add the presign function.** In `apps/api/src/services/object-storage/index.ts`, add after `signQrDownloadUrl` (it reuses the same `GetObjectCommand` / `getSignedUrl` / `getPresignerClient` already imported at the top):

```typescript
/**
 * Issues a pre-signed GET URL for a participant-export CSV. Delivered by email
 * to the configured network admin; TTL is the export-specific
 * EXPORT_URL_TTL_SECONDS so it can be tuned independently of bulk-upload URLs.
 *
 * @param key - The S3 object key of the export CSV.
 * @returns The signed URL, its key, and an ISO expiry timestamp.
 */
export async function signExportDownloadUrl(key: string): Promise<SignedDownloadUrl> {
  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ResponseContentDisposition: 'attachment; filename="participant-export.csv"',
    ResponseContentType: 'text/csv',
  });
  const url = await getSignedUrl(getPresignerClient(), command, {
    expiresIn: config.EXPORT_URL_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + config.EXPORT_URL_TTL_SECONDS * 1000).toISOString();
  return { url, key, expiresAt };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @aggregator-dpg/api test -- src/services/object-storage/index.test.ts -t "signExportDownloadUrl"`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @aggregator-dpg/api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/errors/codes.ts \
        apps/api/src/services/object-storage/index.ts \
        apps/api/src/services/object-storage/index.test.ts
git commit -m "feat(campaign-export): config, error codes, and S3 export presign (#579)"
```

---

## Task 2: `runExport` orchestrator service

**Files:**

- Create: `apps/api/src/services/campaign-export/index.ts`
- Test: `apps/api/src/services/campaign-export/index.test.ts`

**Interfaces:**

- Consumes: `signExportDownloadUrl` and `putObject` (Task 1 / existing object-storage); `buildDecryptedProfilesCsv(rows)` from `../profile-csv.js`; `SignalStackFetchDecryptedProfilesQuery`, `SignalStackDecryptedProfiles`, `SignalStackDecryptedProfileRow` from `@aggregator-dpg/signalstack-writer/interface`; `Result<T,E>` from `@aggregator-dpg/shared-primitives/result`; `BaseError` from `@aggregator-dpg/shared-primitives/errors`; `SendInput`, `SendOk`, `MailerResult` from `../mailer/interface.js`; `SignedDownloadUrl` from `../object-storage/index.js`.
- Produces:
  - `interface ExportParams { orgId: string; itemIds: string[]; purpose?: string }`
  - `interface ExportLogger { info(o: object): void; warn(o: object): void; error(o: object): void }`
  - `interface ExportDeps { fetchDecryptedProfiles: (q: SignalStackFetchDecryptedProfilesQuery) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>; putObject: (key: string, body: Buffer, contentType: string) => Promise<void>; signDownloadUrl: (key: string) => Promise<SignedDownloadUrl>; sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>; networkAdminEmail: string; log: ExportLogger }`
  - `runExport(params: ExportParams, deps: ExportDeps): Promise<void>` — never throws; logs and returns on every failure branch.

- [ ] **Step 1: Write the failing tests** — create `apps/api/src/services/campaign-export/index.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '../mailer/interface.js';
import type { SignedDownloadUrl } from '../object-storage/index.js';
import { runExport, type ExportDeps } from './index.js';

function row(
  overrides: Partial<SignalStackDecryptedProfileRow> = {},
): SignalStackDecryptedProfileRow {
  return {
    item_id: 'item-1',
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: { name: 'Asha', phone: '+910000000000' },
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

interface Harness {
  deps: ExportDeps;
  puts: Array<{ key: string; body: Buffer; contentType: string }>;
  mails: SendInput[];
  logs: { info: object[]; warn: object[]; error: object[] };
}

function harness(over: Partial<ExportDeps> = {}): Harness {
  const puts: Harness['puts'] = [];
  const mails: SendInput[] = [];
  const logs = { info: [] as object[], warn: [] as object[], error: [] as object[] };
  const deps: ExportDeps = {
    fetchDecryptedProfiles: async () => ok({ profiles: [row()], skipped: [] }),
    putObject: async (key, body, contentType) => {
      puts.push({ key, body, contentType });
    },
    signDownloadUrl: async (key): Promise<SignedDownloadUrl> => ({
      url: `https://signed.example/${key}`,
      key,
      expiresAt: '2026-08-01T01:00:00.000Z',
    }),
    sendMail: async (input): Promise<MailerResult<SendOk>> => {
      mails.push(input);
      return { ok: true, value: { messageId: 'm-1' } };
    },
    networkAdminEmail: 'admin@network.org',
    log: {
      info: (o) => logs.info.push(o),
      warn: (o) => logs.warn.push(o),
      error: (o) => logs.error.push(o),
    },
    ...over,
  };
  return { deps, puts, mails, logs };
}

describe('runExport', () => {
  it('uploads a CSV and emails the network admin with exported/skipped counts', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () =>
        ok({ profiles: [row({ item_id: 'a' }), row({ item_id: 'b' })], skipped: ['c'] }),
    });

    await runExport({ orgId: 'org-1', itemIds: ['a', 'b', 'c'], purpose: 'audit' }, h.deps);

    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.key).toMatch(/^campaign-exports\/org-1\/.*\.csv$/);
    expect(h.puts[0]!.contentType).toBe('text/csv');
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0]!.to).toBe('admin@network.org');
    expect(h.mails[0]!.text).toContain('Records exported: 2');
    expect(h.mails[0]!.text).toContain('Skipped (not found / not owned): 1');
    expect(h.mails[0]!.text).toContain('org-1');
    expect(h.mails[0]!.text).toContain('audit');
    expect(h.mails[0]!.text).toContain('https://signed.example/');
  });

  it('does nothing (no upload, no email) when no items resolve', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () => ok({ profiles: [], skipped: ['x', 'y'] }),
    });
    await runExport({ orgId: 'org-1', itemIds: ['x', 'y'] }, h.deps);
    expect(h.puts).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
    expect(h.logs.warn).toHaveLength(1);
  });

  it('aborts (no upload, no email) when resolved items span more than one type/domain', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () =>
        ok({
          profiles: [row({ item_domain: 'seeker' }), row({ item_domain: 'provider' })],
          skipped: [],
        }),
    });
    await runExport({ orgId: 'org-1', itemIds: ['a', 'b'] }, h.deps);
    expect(h.puts).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
    expect(h.logs.error).toHaveLength(1);
  });

  it('aborts when decrypt fails', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () => err(new UpstreamError('signals down', { code: 'X' })),
    });
    await runExport({ orgId: 'org-1', itemIds: ['a'] }, h.deps);
    expect(h.puts).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
    expect(h.logs.error).toHaveLength(1);
  });

  it('logs a failure and does not throw when the email send fails', async () => {
    const h = harness({
      sendMail: async () => ({
        ok: false,
        error: { code: 'TRANSPORT_FAILED', message: 'smtp down' },
      }),
    });
    await expect(runExport({ orgId: 'org-1', itemIds: ['a'] }, h.deps)).resolves.toBeUndefined();
    expect(h.puts).toHaveLength(1); // upload still happened before the email
    expect(h.logs.error).toHaveLength(1);
  });

  it('never logs raw item_state / PII values', async () => {
    const h = harness();
    await runExport({ orgId: 'org-1', itemIds: ['a'] }, h.deps);
    const serialized = JSON.stringify([...h.logs.info, ...h.logs.warn, ...h.logs.error]);
    expect(serialized).not.toContain('Asha');
    expect(serialized).not.toContain('+910000000000');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @aggregator-dpg/api test -- src/services/campaign-export/index.test.ts`
Expected: FAIL — `./index.js` (runExport) does not exist.

- [ ] **Step 3: Write the implementation** — create `apps/api/src/services/campaign-export/index.ts`:

```typescript
/**
 * Participant PII export orchestrator (interim, aggregator-dpg#579).
 *
 * Decrypts a set of owned Signals items, writes a CSV to private S3, and emails
 * a short-lived pre-signed download link to the configured network admin. Runs
 * fire-and-forget from the route: it NEVER throws and NEVER logs PII — every
 * failure branch logs counts only and returns. Belongs to `@aggregator-dpg/api`.
 */
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type {
  SignalStackFetchDecryptedProfilesQuery,
  SignalStackDecryptedProfiles,
} from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '../mailer/interface.js';
import type { SignedDownloadUrl } from '../object-storage/index.js';
import { buildDecryptedProfilesCsv } from '../profile-csv.js';

/** Request-scoped inputs resolved from the route body + `x-org-id` header. */
export interface ExportParams {
  orgId: string;
  itemIds: string[];
  purpose?: string;
}

/** Minimal structured logger surface (satisfied by `req.log.child(...)`). */
export interface ExportLogger {
  info(obj: object): void;
  warn(obj: object): void;
  error(obj: object): void;
}

/** Injected collaborators — narrow function types so the job is trivially faked. */
export interface ExportDeps {
  fetchDecryptedProfiles: (
    q: SignalStackFetchDecryptedProfilesQuery,
  ) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;
  putObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  signDownloadUrl: (key: string) => Promise<SignedDownloadUrl>;
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
  networkAdminEmail: string;
  log: ExportLogger;
}

interface ExportEmailInput {
  orgId: string;
  purpose: string;
  domain: string;
  exported: number;
  skipped: number;
  url: string;
  expiresAt: string;
}

/** Escapes the few HTML metacharacters that can appear in org id / purpose. */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Renders the network-admin notification (link only — never the PII itself). */
function renderExportEmail(i: ExportEmailInput): { subject: string; html: string; text: string } {
  const subject = `PII export ready — ${i.domain} (${i.exported} records)`;
  const text = [
    'A participant PII export is ready.',
    '',
    `Requested by org: ${i.orgId}`,
    `Purpose: ${i.purpose}`,
    `Records exported: ${i.exported}`,
    `Skipped (not found / not owned): ${i.skipped}`,
    '',
    `Download (expires ${i.expiresAt}):`,
    i.url,
    '',
    'This link is time-limited and the file contains personal data. Do not forward it.',
  ].join('\n');
  const html = [
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.5">',
    '<p>A participant PII export is ready.</p>',
    '<ul>',
    `<li>Requested by org: <strong>${esc(i.orgId)}</strong></li>`,
    `<li>Purpose: ${esc(i.purpose)}</li>`,
    `<li>Records exported: <strong>${i.exported}</strong></li>`,
    `<li>Skipped (not found / not owned): <strong>${i.skipped}</strong></li>`,
    '</ul>',
    `<p><a href="${esc(i.url)}">Download the export</a> (expires ${esc(i.expiresAt)}).</p>`,
    '<p style="color:#a00">This link is time-limited and the file contains personal data. Do not forward it.</p>',
    '</div>',
  ].join('');
  return { subject, html, text };
}

/**
 * Runs one export end-to-end. Fire-and-forget: awaited only in tests.
 *
 * @param params - orgId (Signals org id), itemIds, optional purpose.
 * @param deps - Injected decrypt / storage / mail collaborators + admin email + logger.
 */
export async function runExport(params: ExportParams, deps: ExportDeps): Promise<void> {
  const { orgId, itemIds, purpose } = params;
  const start = Date.now();
  const base = { operation: 'campaign.export', org_id: orgId, requested: itemIds.length };

  const result = await deps.fetchDecryptedProfiles({ actingOrgId: orgId, itemIds });
  if (!result.ok) {
    deps.log.error({
      ...base,
      status: 'failure',
      step: 'decrypt',
      latency_ms: Date.now() - start,
      error: result.error.message,
      error_type: result.error.code,
    });
    return;
  }

  const { profiles, skipped } = result.value;

  if (profiles.length === 0) {
    deps.log.warn({
      ...base,
      status: 'skipped',
      reason: 'no_resolvable_items',
      latency_ms: Date.now() - start,
      exported: 0,
      skipped: skipped.length,
    });
    return;
  }

  const distinct = new Set(profiles.map((p) => `${p.item_domain}/${p.item_type}`));
  if (distinct.size > 1) {
    deps.log.error({
      ...base,
      status: 'failure',
      step: 'validate',
      latency_ms: Date.now() - start,
      error: 'mixed item_type/domain in export request',
      error_type: 'MIXED_ITEM_TYPES',
      distinct: [...distinct],
    });
    return;
  }

  const domain = profiles[0]!.item_domain;
  const csv = buildDecryptedProfilesCsv(profiles);
  const key = `campaign-exports/${orgId}/${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

  await deps.putObject(key, Buffer.from(csv, 'utf8'), 'text/csv');
  const signed = await deps.signDownloadUrl(key);

  const email = renderExportEmail({
    orgId,
    purpose: purpose && purpose.trim() ? purpose : '—',
    domain,
    exported: profiles.length,
    skipped: skipped.length,
    url: signed.url,
    expiresAt: signed.expiresAt,
  });

  const sent = await deps.sendMail({
    to: deps.networkAdminEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  if (!sent.ok) {
    deps.log.error({
      ...base,
      status: 'failure',
      step: 'email',
      latency_ms: Date.now() - start,
      error: sent.error.message,
      error_type: sent.error.code,
      s3_key: key,
    });
    return;
  }

  deps.log.info({
    ...base,
    status: 'success',
    latency_ms: Date.now() - start,
    exported: profiles.length,
    skipped: skipped.length,
    s3_key: key,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @aggregator-dpg/api test -- src/services/campaign-export/index.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @aggregator-dpg/api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/campaign-export/index.ts apps/api/src/services/campaign-export/index.test.ts
git commit -m "feat(campaign-export): runExport orchestrator (decrypt -> csv -> s3 -> email) (#579)"
```

---

## Task 3: Route + registration

**Files:**

- Create: `apps/api/src/routes/campaign-export.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/campaign-export.test.ts`

**Interfaces:**

- Consumes: `runExport`, `ExportDeps` (Task 2); `config`, `exportNetworkAdminEmail` (Task 1 / config); `getSignalStackWriter` from `../services/signalstack.js`; `getMailer` from `../services/mailer/index.js`; `putObject`, `signExportDownloadUrl` from `../services/object-storage/index.js`; `httpError` from `../errors/http-error.js`; `errorResponses` from `../errors/openapi.js`.
- Produces: `registerCampaignExportRoutes(app: FastifyInstance): Promise<void>` — registered in `app.ts`. Endpoint `POST /v1/campaign/export`.

- [ ] **Step 1: Write the failing tests** — create `apps/api/src/routes/campaign-export.test.ts`:

```typescript
// Env must be set before any import that pulls in `config` (parsed once at
// first import). Mirrors the support.test.ts convention.
process.env.EXPORT_NETWORK_ADMIN_EMAIL = 'admin@network.org';
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc-org';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { _setSignalStackWriter } from '../services/signalstack.js';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

describe('POST /v1/campaign/export', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.EXPORT_NETWORK_ADMIN_EMAIL = 'admin@network.org';
    // Inject an empty fake writer: decrypt resolves to nothing, so the
    // fire-and-forget job hits the empty-guard and performs no S3/mail I/O —
    // keeping these tests deterministic on the synchronous contract.
    _setSignalStackWriter(new SignalStackWriterFake());
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setSignalStackWriter(null);
  });

  it('returns 202 { status: "queued" } for a valid, configured request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { 'x-org-id': 'org-1' },
      payload: { item_ids: [VALID_UUID], purpose: 'audit' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'queued' });
  });

  it('returns 401 MISSING_ORG_ID when x-org-id is absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MISSING_ORG_ID');
  });

  it('returns 400 for an invalid body (non-uuid item id)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { 'x-org-id': 'org-1' },
      payload: { item_ids: ['not-a-uuid'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an empty item_ids array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { 'x-org-id': 'org-1' },
      payload: { item_ids: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 EXPORT_NOT_CONFIGURED when the network admin email is unset', async () => {
    delete process.env.EXPORT_NETWORK_ADMIN_EMAIL;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { 'x-org-id': 'org-1' },
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('EXPORT_NOT_CONFIGURED');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @aggregator-dpg/api test -- src/routes/campaign-export.test.ts`
Expected: FAIL — route not registered (404) / module missing.

- [ ] **Step 3a: Write the route** — create `apps/api/src/routes/campaign-export.ts`:

```typescript
/**
 * Campaign participant PII export (interim, aggregator-dpg#579).
 *
 *   POST /v1/campaign/export → 202; async, fire-and-forget.
 *
 * Interim auth is the `x-org-id` header (the caller's Signals org id), passed
 * straight through to Signals decrypt, which enforces ownership via
 * `onboarded_by`. Swapped for KC-token validation when #576 lands. The route
 * never returns PII — only a queued acknowledgement; the export is delivered as
 * a pre-signed link emailed to the configured network admin. Belongs to
 * `@aggregator-dpg/api`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getSignalStackWriter } from '../services/signalstack.js';
import { getMailer } from '../services/mailer/index.js';
import { putObject, signExportDownloadUrl } from '../services/object-storage/index.js';
import { runExport } from '../services/campaign-export/index.js';
import { config, exportNetworkAdminEmail } from '../config.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

const ExportRequestSchema = z
  .object({
    item_ids: z.array(z.string().uuid()).min(1).max(config.EXPORT_MAX_ITEM_IDS),
    purpose: z.string().trim().max(500).optional(),
  })
  .strict();

/** Reads and trims the interim `x-org-id` header; undefined when absent/blank. */
function orgIdHeader(req: FastifyRequest): string | undefined {
  const raw = req.headers['x-org-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Registers the campaign-export route. Deliberately NOT under the session-auth
 * hook — the external caller has no session; interim auth is `x-org-id`.
 *
 * @param app - The Fastify instance to attach the route to.
 */
export async function registerCampaignExportRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/campaign/export',
    {
      schema: {
        tags: ['campaign'],
        summary: 'Request an async participant PII export (interim)',
        description:
          'Decrypts the given owned items, writes a CSV to private S3, and emails a short-lived pre-signed link to the configured network admin. Interim auth: x-org-id header (Signals org id). Fire-and-forget: returns 202 immediately.',
        body: ExportRequestSchema,
        response: {
          202: z.object({ status: z.literal('queued') }),
          ...errorResponses(400, 401, 503),
        },
      },
    },
    async (req, reply) => {
      const orgId = orgIdHeader(req);
      if (!orgId) throw httpError('MISSING_ORG_ID');

      const ss = getSignalStackWriter();
      const networkAdminEmail = exportNetworkAdminEmail();
      if (!ss || !networkAdminEmail) throw httpError('EXPORT_NOT_CONFIGURED');

      const { item_ids, purpose } = req.body as z.infer<typeof ExportRequestSchema>;
      const log = req.log.child({ operation: 'campaign.export', org_id: orgId });

      // Fire-and-forget (interim, non-durable): the caller gets 202 at once and
      // the export runs in the background. Every failure is logged, never surfaced.
      void runExport(
        { orgId, itemIds: item_ids, ...(purpose ? { purpose } : {}) },
        {
          fetchDecryptedProfiles: (q) => ss.fetchDecryptedProfiles(q),
          putObject,
          signDownloadUrl: signExportDownloadUrl,
          sendMail: (input) => getMailer().send(input),
          networkAdminEmail,
          log,
        },
      ).catch((cause: unknown) => {
        log.error({
          operation: 'campaign.export',
          status: 'failure',
          error: cause instanceof Error ? cause.message : String(cause),
          error_type: cause instanceof Error ? cause.name : 'Unknown',
        });
      });

      return reply.code(202).send({ status: 'queued' });
    },
  );
}
```

- [ ] **Step 3b: Register the route in `app.ts`.** Add the import beside the other route imports (after the `registerSupportRoutes` import near line 39):

```typescript
import { registerCampaignExportRoutes } from './routes/campaign-export.js';
```

And add the registration call immediately after `await registerSupportRoutes(app);` (near line 198):

```typescript
await registerCampaignExportRoutes(app);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @aggregator-dpg/api test -- src/routes/campaign-export.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Full check (typecheck + lint + the whole api suite)**

Run:

```bash
pnpm --filter @aggregator-dpg/api typecheck
pnpm --filter @aggregator-dpg/api lint
pnpm --filter @aggregator-dpg/api test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/campaign-export.ts apps/api/src/routes/campaign-export.test.ts apps/api/src/app.ts
git commit -m "feat(campaign-export): POST /v1/campaign/export route + registration (#579)"
```

---

## Post-implementation notes (not code)

- **Env to set on deploy:** `EXPORT_NETWORK_ADMIN_EMAIL` (required to enable), optional `EXPORT_MAX_ITEM_IDS` / `EXPORT_URL_TTL_SECONDS`. Reuses existing `S3_BUCKET`, `SIGNALSTACK_*`, mailer (`MAIL_PROVIDER` + SMTP/SES) config. Add these to `infra/env.template` and the relevant `config/env/*.yaml` as a follow-up doc chore.
- **Deferred (out of scope, per spec §11):** S3 lifecycle auto-delete (bluedots-automation) — exports persist until that rule exists; KC-token auth (#576); durable worker execution; unified audit table; idempotency; consent/OTP; notification-service migration.
- **Manual verification:** with the stack up + `EXPORT_NETWORK_ADMIN_EMAIL` set to a Mailpit-visible address, `POST /v1/campaign/export` with real owned item_ids and confirm (a) 202, (b) an email arrives at Mailpit with a working MinIO/S3 link, (c) the CSV contains the decrypted rows, (d) skipped/mixed/empty behave per spec.
