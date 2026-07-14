# Support / contact form (aggregator) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Contact support" row to the aggregator portal Sidebar that opens a modal and emails the submission (plus the submitter's details) to a configured `SUPPORT_EMAIL` via the aggregator's own mailer.

**Architecture:** New `apps/api` route module (`GET /v1/support/config` + `POST /v1/support`) reuses `getMailer()` + a new `renderSupportRequest` email template. The Next.js web adds BFF proxy routes (`app/api/support*`), a `SupportDialog` modal, and a Sidebar row gated on a server-fetched `supportEnabled` flag. Email-only; audit/metrics deferred to telemetry.

**Tech Stack:** TypeScript (ESM), Fastify + Zod (`apps/api`), Next.js 15 App Router + next-intl (`apps/web`), Vitest, the repo's own mailer (`getMailer`/`FakeMailer`) and error catalogue.

## Global Constraints

- **Conventions (`.claude/rules`) are non-negotiable:** TSDoc on public functions; structured logging via `req.log`/`logger` with `operation`/`status`/`latency_ms` (never `console.log`); config read once from `config` (`apps/api/src/config.ts`), never hardcoded; external calls handled via typed errors, no empty catches.
- **Errors:** route handlers `throw httpError('<CODE>', { … })` where `<CODE>` is in the `ERR` catalogue (`apps/api/src/errors/codes.ts`). New codes: `SUPPORT_NOT_CONFIGURED` (503), `SUPPORT_SEND_FAILED` (502).
- **Mailer:** `getMailer().send({ to, subject, html, text, replyTo? }): Promise<MailerResult<SendOk>>` → `{ ok:true, value } | { ok:false, error }`. Tests use `FakeMailer` + `_setMailer` (`apps/api/src/services/mailer/index.js`).
- **Email templates** live in `apps/api/src/services/email-templates/`, are pure `renderX(vars) → { subject, html, text }`, and use `escapeHtml` / `renderShell` from `./shared.js`. All user-supplied text is HTML-escaped; the subject is one line.
- **Body fields:** optional `subject` (≤200), required `message` (1–5000).
- **Email user context:** name (`preferredUsername`/email), email, phone, user id (`userId`), aggregator id, submitted-at.
- **Reply-To** = submitter's email (mailer falls back to its default `from` when absent).
- **Button** hidden when `SUPPORT_EMAIL` unset; label "Contact support"; `message` icon; Sidebar bottom, above the org card.
- **i18n:** next-intl flat namespaces in `apps/web/src/i18n/messages/{en,hi,kn}.json` — add a `support` namespace + `nav.contact_support`.
- Node ≥ 24, pnpm. Filters: `@aggregator-dpg/api`, `@aggregator-dpg/web`. Conventional Commits; husky runs prettier+eslint on commit (do **not** `--no-verify`).

---

## File Structure

- `apps/api/src/errors/codes.ts` — **modify.** Add `SUPPORT_NOT_CONFIGURED`, `SUPPORT_SEND_FAILED`.
- `apps/api/src/config.ts` — **modify.** Add `SUPPORT_EMAIL` to `ConfigSchema`.
- `apps/api/src/services/email-templates/support-request.ts` — **create.** `renderSupportRequest`.
- `apps/api/src/services/email-templates/index.ts` — **modify.** Export it.
- `apps/api/src/routes/support.ts` — **create.** `registerSupportRoutes` (config + submit).
- `apps/api/src/app.ts` — **modify.** Register the route module.
- `apps/web/src/app/api/support/route.ts` — **create.** BFF `POST` proxy.
- `apps/web/src/app/api/support/config/route.ts` — **create.** BFF `GET` proxy.
- `apps/web/src/components/support/SupportDialog.tsx` — **create.** The modal.
- `apps/web/src/components/shell/Sidebar.tsx` — **modify.** Add the row (gated on `supportEnabled`).
- `apps/web/src/lib/auth-context.tsx` — **modify.** Carry `supportEnabled`.
- `apps/web/src/app/(protected)/layout.tsx` — **modify.** Fetch config SSR, pass the flag.
- `apps/web/src/i18n/messages/{en,hi,kn}.json` — **modify.** Add keys.
- `infra/env.template`, `SETUP.md` — **modify.** Document `SUPPORT_EMAIL`.

---

### Task 1: API — error codes + `SUPPORT_EMAIL` config

**Files:**

- Modify: `apps/api/src/errors/codes.ts` (`ERR`)
- Modify: `apps/api/src/config.ts` (`ConfigSchema`)

**Interfaces:**

- Produces: `ERR.SUPPORT_NOT_CONFIGURED` (status 503), `ERR.SUPPORT_SEND_FAILED` (status 502); `config.SUPPORT_EMAIL: string | undefined`.

- [ ] **Step 1: Add the two error-catalogue entries**

In `apps/api/src/errors/codes.ts`, inside the `ERR = { … }` object (place near the other 5xx entries, e.g. after `SIGNALSTACK_PUSH_FAILED`), add:

```ts
  SUPPORT_NOT_CONFIGURED: {
    code: 'SUPPORT_NOT_CONFIGURED',
    status: 503,
    title: 'Support unavailable',
    detail: 'Support is not configured on this instance.',
    hint: 'Set SUPPORT_EMAIL to enable the contact-support form.',
  },
  SUPPORT_SEND_FAILED: {
    code: 'SUPPORT_SEND_FAILED',
    status: 502,
    title: 'Could not send support message',
    detail: 'Failed to send your message. Please try again later.',
    hint: 'The mail transport rejected or failed the send.',
  },
```

(Match the exact field set used by the neighbouring entries — if they omit `hint` or add other fields, mirror that shape.)

- [ ] **Step 2: Add `SUPPORT_EMAIL` to the config schema**

In `apps/api/src/config.ts`, inside `ConfigSchema = z.object({ … })`, near `ADMIN_EMAILS`, add:

```ts
  /** Recipient for contact-support submissions (#120-equivalent). Feature-gated: unset ⇒ endpoint 503, web button hidden. */
  SUPPORT_EMAIL: z.string().optional(),
```

- [ ] **Step 3: Typecheck + existing tests**

Run: `pnpm --filter @aggregator-dpg/api typecheck && pnpm --filter @aggregator-dpg/api test`
Expected: pass. (Wiring only; exercised by Tasks 2–3.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/errors/codes.ts apps/api/src/config.ts
git commit -m "feat(api): support error codes + SUPPORT_EMAIL config"
```

---

### Task 2: API — `renderSupportRequest` email template

**Files:**

- Create: `apps/api/src/services/email-templates/support-request.ts`
- Modify: `apps/api/src/services/email-templates/index.ts`
- Test: `apps/api/src/services/email-templates/__tests__/support-request.test.ts`

**Interfaces:**

- Consumes: `escapeHtml`, `renderShell` from `./shared.js`.
- Produces: `interface SupportRequestVars { subject?: string; message: string; name: string; email: string | null; phone: string | null; userId: string; aggregatorId: string; submittedAt: Date }` and `renderSupportRequest(v: SupportRequestVars): { subject: string; html: string; text: string }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/email-templates/__tests__/support-request.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderSupportRequest } from '../support-request.js';

const base = {
  message: 'It broke',
  name: 'Asha K',
  email: 'asha@example.com',
  phone: '+919000000000',
  userId: 'user-123',
  aggregatorId: 'agg-9',
  submittedAt: new Date('2026-07-09T10:00:00.000Z'),
};

describe('renderSupportRequest', () => {
  it('uses the provided subject in the subject line', () => {
    expect(renderSupportRequest({ ...base, subject: 'Cannot log in' }).subject).toBe(
      '[Support] Cannot log in — Asha K',
    );
  });

  it('falls back to a default subject when none is given', () => {
    expect(renderSupportRequest(base).subject).toBe('[Support] New support request — Asha K');
  });

  it('includes the message and every detail in html and text', () => {
    const { html, text } = renderSupportRequest(base);
    for (const needle of [
      'It broke',
      'Asha K',
      'asha@example.com',
      '+919000000000',
      'user-123',
      'agg-9',
    ]) {
      expect(html).toContain(needle);
      expect(text).toContain(needle);
    }
  });

  it('HTML-escapes user-supplied message and name; flattens subject newlines', () => {
    const r = renderSupportRequest({
      ...base,
      subject: 'a\nb',
      message: '<script>x</script>',
      name: 'A<b>C',
    });
    expect(r.subject).toBe('[Support] a b — A<b>C');
    expect(r.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('A&lt;b&gt;C');
  });

  it('renders a dash for missing email/phone', () => {
    const { html } = renderSupportRequest({ ...base, email: null, phone: null });
    expect(html).toContain('—');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aggregator-dpg/api test -- support-request.test.ts`
Expected: FAIL — cannot find `../support-request.js`.

- [ ] **Step 3: Create the template**

Create `apps/api/src/services/email-templates/support-request.ts`:

```ts
/**
 * Support / contact-form email — sent to SUPPORT_EMAIL when a coordinator
 * submits the in-app "Contact support" form. Carries the message plus the
 * submitter's identity so support can follow up (Reply-To is the submitter).
 *
 * Belongs to `@aggregator-dpg/api`.
 */

import { escapeHtml, renderShell } from './shared.js';

/** Inputs for {@link renderSupportRequest}. */
export interface SupportRequestVars {
  subject?: string;
  message: string;
  name: string;
  email: string | null;
  phone: string | null;
  userId: string;
  aggregatorId: string;
  submittedAt: Date;
}

/** Collapse whitespace/newlines to single spaces (safe for an email header). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Renders the support-request email.
 *
 * @param v - The submitted subject/message plus resolved submitter details.
 * @returns The email `subject`, `html`, and plain-text `text` fallback.
 */
export function renderSupportRequest(v: SupportRequestVars): {
  subject: string;
  html: string;
  text: string;
} {
  const subjectText = v.subject && v.subject.trim() ? oneLine(v.subject) : 'New support request';
  const subject = `[Support] ${subjectText} — ${oneLine(v.name)}`;

  const submitted = `${v.submittedAt.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })} IST`;

  const rows: Array<[string, string]> = [
    ['Name', v.name],
    ['Email', v.email ?? '—'],
    ['Phone', v.phone ?? '—'],
    ['User ID', v.userId],
    ['Aggregator ID', v.aggregatorId],
    ['Submitted at', submitted],
  ];
  const detailRows = rows
    .map(
      ([k, val]) =>
        `<tr><td style="padding:6px 0;color:#475069;width:140px;">${escapeHtml(k)}</td>` +
        `<td style="padding:6px 0;color:#0b1020;">${escapeHtml(val)}</td></tr>`,
    )
    .join('');

  const body = `
<h1 style="font-size:20px;font-weight:700;margin:0 0 8px;color:#0b1020;">New support request</h1>
<div style="margin:12px 0;padding:14px;background:#f7f8fb;border-radius:10px;font-size:14px;color:#0b1020;line-height:1.5;white-space:pre-wrap;">${escapeHtml(
    v.message,
  )}</div>
<table style="border-collapse:collapse;font-size:13px;">${detailRows}</table>`;

  const html = renderShell({ title: subject, body });

  const text = `${subject}\n\n${v.message}\n\n` + rows.map(([k, val]) => `${k}: ${val}`).join('\n');

  return { subject, html, text };
}
```

Note: confirm `renderShell`'s option shape (`apps/api/src/services/email-templates/shared.ts`); it takes an options object (e.g. `{ title, body }`). Adjust the `renderShell({ … })` call to its exact `ShellOptions` fields.

- [ ] **Step 4: Export from the index**

In `apps/api/src/services/email-templates/index.ts`, add:

```ts
export { renderSupportRequest, type SupportRequestVars } from './support-request.js';
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @aggregator-dpg/api test -- support-request.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/email-templates/support-request.ts apps/api/src/services/email-templates/index.ts apps/api/src/services/email-templates/__tests__/support-request.test.ts
git commit -m "feat(api): support-request email template"
```

---

### Task 3: API — support routes (`GET /v1/support/config`, `POST /v1/support`)

**Files:**

- Create: `apps/api/src/routes/support.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/support.test.ts`

**Interfaces:**

- Consumes: `config` (Task 1), `renderSupportRequest` (Task 2), `getMailer` + `MailerResult`, `httpError` + the new `ERR` codes, `authenticate`/`AuthContext` (`services/auth/access-token.js`).
- Produces: `registerSupportRoutes(app: FastifyInstance): void`. `GET /v1/support/config → { enabled: boolean }`; `POST /v1/support` body `{ subject?, message }` → `201 { ok: true }` / 503 / 502 / 400 / 401.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/support.test.ts`. Mirror the app-build + `FakeMailer` harness from `apps/api/src/routes/aggregator-approvals.test.ts` (`buildApp`, `FakeMailer`, `_setMailer`) and the **authenticated-request** harness from `apps/api/src/routes/aggregator-profile.test.ts` (how it mints/attaches a Bearer token or fakes `authenticate` so `requireAuth` yields an `AuthContext` with `userId`/`aggregatorId`/`email`). Concretely:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { FakeMailer, _setMailer } from '../services/mailer/index.js';

// Fake auth so requireAuth yields a coordinator context. Copy the exact
// mock target + AuthContext shape from aggregator-profile.test.ts.
vi.mock('../services/auth/access-token.js', async (orig) => {
  const mod = await orig<typeof import('../services/auth/access-token.js')>();
  return {
    ...mod,
    authenticate: vi.fn(async () => ({
      ok: true,
      value: {
        userId: 'u1',
        aggregatorId: 'agg-9',
        email: 'asha@example.com',
        phoneNumber: '+919000000000',
        preferredUsername: 'Asha K',
      },
    })),
  };
});

describe('support routes', () => {
  let app: FastifyInstance;
  let mailer: FakeMailer;

  beforeEach(async () => {
    mailer = new FakeMailer();
    _setMailer(mailer);
    process.env.SUPPORT_EMAIL = 'support@org.com';
    vi.resetModules();
  });
  afterEach(async () => {
    _setMailer(null);
    delete process.env.SUPPORT_EMAIL;
    await app?.close();
  });

  it('sends the support email and returns 201', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer x' },
      payload: { subject: 'Help', message: 'It broke' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
    const sent = mailer.sent; // FakeMailer records sends — confirm the accessor name
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('support@org.com');
    expect(sent[0].replyTo).toBe('asha@example.com');
    expect(sent[0].subject).toContain('Help');
    expect(sent[0].html).toContain('It broke');
  });

  it('returns 400 for an empty message', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer x' },
      payload: { message: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 when SUPPORT_EMAIL is unset', async () => {
    delete process.env.SUPPORT_EMAIL;
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer x' },
      payload: { message: 'hi' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('config endpoint reports enabled', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/support/config',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true });
  });
});
```

Before running, open `aggregator-profile.test.ts` and `FakeMailer` (`services/mailer/testing.ts`) and align: (a) the exact `authenticate` mock/token approach, (b) `config.SUPPORT_EMAIL` is read at import — if `config` is frozen at first import, set `SUPPORT_EMAIL` before `buildApp()`/module load (the `vi.resetModules()` above supports this; adjust if the harness differs), (c) the `FakeMailer` sent-messages accessor name (`.sent` / `.messages` / `.outbox`).

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aggregator-dpg/api test -- support.test.ts`
Expected: FAIL — route not registered (404) / module missing.

- [ ] **Step 3: Create the route module**

Create `apps/api/src/routes/support.ts`:

```ts
/**
 * Contact-support endpoints (post-login).
 *
 *   GET  /v1/support/config → { enabled }   — whether SUPPORT_EMAIL is set.
 *   POST /v1/support        → emails the submission to SUPPORT_EMAIL.
 *
 * Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type AuthContext } from '../services/auth/access-token.js';
import { getMailer } from '../services/mailer/index.js';
import { renderSupportRequest } from '../services/email-templates/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { config } from '../config.js';

const SupportRequestSchema = z
  .object({
    subject: z.string().max(200).optional(),
    message: z.string().min(1).max(5000),
  })
  .strict();

/** Unwrap the auth context or throw the catalogue UNAUTHORIZED error. Mirrors the local helper in other route modules. */
async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req);
  if (!result.ok) throw httpError('UNAUTHORIZED', { cause: new Error(result.error.message) });
  return result.value;
}

/**
 * Registers the contact-support routes on the given Fastify instance.
 *
 * @param app - The Fastify instance to attach routes to.
 */
export function registerSupportRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/support/config',
    {
      schema: {
        tags: ['support'],
        summary: 'Whether the contact-support form is enabled',
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ enabled: z.boolean() }), ...errorResponses(401) },
      },
    },
    async (req, reply) => {
      await requireAuth(req);
      return reply.send({ enabled: Boolean(config.SUPPORT_EMAIL) });
    },
  );

  app.post(
    '/v1/support',
    {
      schema: {
        tags: ['support'],
        summary: 'Send a contact-support message',
        security: [{ bearerAuth: [] }],
        body: SupportRequestSchema,
        response: { 201: z.object({ ok: z.boolean() }), ...errorResponses(400, 401, 502, 503) },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const log = req.log.child({ operation: 'support.submit', actor: auth.userId });
      const start = Date.now();

      if (!config.SUPPORT_EMAIL) {
        throw httpError('SUPPORT_NOT_CONFIGURED');
      }

      const { subject, message } = req.body as z.infer<typeof SupportRequestSchema>;
      const email = renderSupportRequest({
        subject,
        message,
        name: auth.preferredUsername ?? auth.email ?? auth.userId,
        email: auth.email ?? null,
        phone: auth.phoneNumber ?? null,
        userId: auth.userId,
        aggregatorId: auth.aggregatorId,
        submittedAt: new Date(),
      });

      const sent = await getMailer().send({
        to: config.SUPPORT_EMAIL,
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(auth.email ? { replyTo: auth.email } : {}),
      });

      if (!sent.ok) {
        log.error({
          status: 'failure',
          latency_ms: Date.now() - start,
          error: sent.error.message,
          error_type: sent.error.name,
        });
        throw httpError('SUPPORT_SEND_FAILED', { cause: new Error(sent.error.message) });
      }

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        aggregator_id: auth.aggregatorId,
      });
      return reply.code(201).send({ ok: true });
    },
  );
}
```

Confirm against the codebase while writing: the exact `authenticate` return shape (`{ ok, value } | { ok:false, error }`) and `AuthContext` field names (`preferredUsername`, `phoneNumber`); the `errorResponses(...)` helper import; and whether route schemas use the Zod type-provider (they do elsewhere — mirror `aggregator-profile.ts`).

- [ ] **Step 4: Register the route module**

In `apps/api/src/app.ts`, add the import beside the other `registerXRoutes` imports:

```ts
import { registerSupportRoutes } from './routes/support.js';
```

and call it where the other route modules are registered (same style — `registerSupportRoutes(app)` or `await app.register(...)`, matching how e.g. `registerAggregatorProfileRoutes` is invoked).

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @aggregator-dpg/api test -- support.test.ts`
Expected: PASS (4 tests). Then `pnpm --filter @aggregator-dpg/api typecheck`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/support.ts apps/api/src/routes/support.test.ts apps/api/src/app.ts
git commit -m "feat(api): POST /v1/support + GET /v1/support/config"
```

---

### Task 4: Web — BFF proxy routes

**Files:**

- Create: `apps/web/src/app/api/support/route.ts`
- Create: `apps/web/src/app/api/support/config/route.ts`

**Interfaces:**

- Consumes: `callApi` (`apps/web/src/lib/upstream-client.ts`) — forwards the user session token.
- Produces: `POST /api/support` and `GET /api/support/config` (browser-facing), each proxying to the matching `apps/api` route.

- [ ] **Step 1: Create the POST proxy**

Create `apps/web/src/app/api/support/route.ts`. Follow an existing authenticated BFF route that uses `callApi` (grep `apps/web/src/app/api` for a handler importing `callApi` from `../../../lib/upstream-client` and copy its structure — session read, `callApi(path, { method, body })`, pass-through of status + JSON, `bff-errors` for offline/unauth):

```ts
/**
 * BFF proxy for contact-support submissions. Forwards the authenticated
 * user's request to `apps/api POST /v1/support`.
 *
 * POST /api/support
 */
import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../lib/upstream-client';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.text();
  const upstream = await callApi('/v1/support', { method: 'POST', body });
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
```

Adjust the `callApi` options to its real signature (confirm `UpstreamCallOptions` in `upstream-client.ts` — `method`, `body`, headers). If the repo has a thinner proxy helper for authenticated calls, use it instead and match its usage verbatim.

- [ ] **Step 2: Create the GET config proxy**

Create `apps/web/src/app/api/support/config/route.ts`:

```ts
/**
 * BFF proxy exposing whether contact-support is enabled.
 *
 * GET /api/support/config
 */
import { NextResponse } from 'next/server';
import { callApi } from '../../../../lib/upstream-client';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const upstream = await callApi('/v1/support/config', { method: 'GET' });
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @aggregator-dpg/web typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/support/route.ts apps/web/src/app/api/support/config/route.ts
git commit -m "feat(web): BFF proxy for contact-support"
```

---

### Task 5: Web — SupportDialog, Sidebar row, layout wiring, i18n

**Files:**

- Create: `apps/web/src/components/support/SupportDialog.tsx`
- Modify: `apps/web/src/components/shell/Sidebar.tsx`
- Modify: `apps/web/src/lib/auth-context.tsx`
- Modify: `apps/web/src/app/(protected)/layout.tsx`
- Modify: `apps/web/src/i18n/messages/{en,hi,kn}.json`
- Test: `apps/web/src/components/support/__tests__/SupportDialog.test.tsx`

**Interfaces:**

- Consumes: `POST /api/support` (Task 4); `useTranslations('support')`; `supportEnabled` from `useAuth()`.
- Produces: `SupportDialog` (`{ open, onOpenChange }`); a Sidebar row rendered when `supportEnabled`.

- [ ] **Step 1: Add i18n keys (en / hi / kn)**

In `apps/web/src/i18n/messages/en.json`, add `nav.contact_support` to the `nav` namespace and a new `support` namespace:

```json
"nav": { "...existing...": "...", "contact_support": "Contact support" },
"support": {
  "title": "Contact support",
  "description": "Tell us what's going on and we'll get back to you.",
  "label_subject": "Subject (optional)",
  "placeholder_subject": "Brief summary",
  "label_message": "Message",
  "placeholder_message": "Describe your issue or request",
  "submit": "Send",
  "cancel": "Cancel",
  "sending": "Sending…",
  "validation_message_required": "Please enter a message",
  "success": "Message sent. Our team will get back to you.",
  "unavailable": "Support isn't available right now. Please try again later.",
  "error": "Couldn't send your message. Please try again in a moment."
}
```

Add the same keys to `hi.json`:

```json
"nav": { "contact_support": "सहायता से संपर्क करें" },
"support": {
  "title": "सहायता से संपर्क करें",
  "description": "हमें बताएं कि क्या समस्या है और हम आपसे संपर्क करेंगे।",
  "label_subject": "विषय (वैकल्पिक)",
  "placeholder_subject": "संक्षिप्त सारांश",
  "label_message": "संदेश",
  "placeholder_message": "अपनी समस्या या अनुरोध का वर्णन करें",
  "submit": "भेजें",
  "cancel": "रद्द करें",
  "sending": "भेजा जा रहा है…",
  "validation_message_required": "कृपया एक संदेश दर्ज करें",
  "success": "संदेश भेजा गया। हमारी टीम आपसे संपर्क करेगी।",
  "unavailable": "सहायता अभी उपलब्ध नहीं है। कृपया बाद में पुनः प्रयास करें।",
  "error": "आपका संदेश नहीं भेजा जा सका। कृपया कुछ देर बाद पुनः प्रयास करें।"
}
```

And `kn.json`:

```json
"nav": { "contact_support": "ಬೆಂಬಲವನ್ನು ಸಂಪರ್ಕಿಸಿ" },
"support": {
  "title": "ಬೆಂಬಲವನ್ನು ಸಂಪರ್ಕಿಸಿ",
  "description": "ಏನಾಗುತ್ತಿದೆ ಎಂದು ನಮಗೆ ತಿಳಿಸಿ, ನಾವು ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತೇವೆ.",
  "label_subject": "ವಿಷಯ (ಐಚ್ಛಿಕ)",
  "placeholder_subject": "ಸಂಕ್ಷಿಪ್ತ ಸಾರಾಂಶ",
  "label_message": "ಸಂದೇಶ",
  "placeholder_message": "ನಿಮ್ಮ ಸಮಸ್ಯೆ ಅಥವಾ ವಿನಂತಿಯನ್ನು ವಿವರಿಸಿ",
  "submit": "ಕಳುಹಿಸಿ",
  "cancel": "ರದ್ದುಮಾಡಿ",
  "sending": "ಕಳುಹಿಸಲಾಗುತ್ತಿದೆ…",
  "validation_message_required": "ದಯವಿಟ್ಟು ಒಂದು ಸಂದೇಶವನ್ನು ನಮೂದಿಸಿ",
  "success": "ಸಂದೇಶ ಕಳುಹಿಸಲಾಗಿದೆ. ನಮ್ಮ ತಂಡ ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತದೆ.",
  "unavailable": "ಬೆಂಬಲ ಸದ್ಯ ಲಭ್ಯವಿಲ್ಲ. ದಯವಿಟ್ಟು ನಂತರ ಪ್ರಯತ್ನಿಸಿ.",
  "error": "ನಿಮ್ಮ ಸಂದೇಶವನ್ನು ಕಳುಹಿಸಲಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಕ್ಷಣದಲ್ಲಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ."
}
```

Merge into the existing `nav` object rather than duplicating the key.

- [ ] **Step 2: Write the failing dialog test**

Create `apps/web/src/components/support/__tests__/SupportDialog.test.tsx`. Mirror the render harness in `apps/web/src/components/consent/__tests__/*` (NextIntlClientProvider wrapper with the messages, or the repo's test-utils render). Assert the two REQUIRED behaviors:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '../../../i18n/messages/en.json';
import { SupportDialog } from '../SupportDialog';

function renderDialog() {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SupportDialog open onOpenChange={() => {}} />
    </NextIntlClientProvider>,
  );
}

describe('SupportDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not submit when the message is empty/whitespace', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    renderDialog();
    await userEvent.type(screen.getByLabelText(/message/i), '   ');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to /api/support and shows success', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 201 }));
    renderDialog();
    await userEvent.type(screen.getByLabelText(/message/i), 'It broke');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/support',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(await screen.findByText(/message sent/i)).toBeTruthy();
  });

  it('shows the unavailable message on 503', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
    renderDialog();
    await userEvent.type(screen.getByLabelText(/message/i), 'hi');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/isn't available|unavailable/i)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web test -- SupportDialog.test.tsx`
Expected: FAIL — cannot find `../SupportDialog`.

- [ ] **Step 4: Create `SupportDialog.tsx`**

Create `apps/web/src/components/support/SupportDialog.tsx`, following the `ConsentModal` overlay/ESC/`useTranslations` pattern, with inline status (the repo uses inline notices, not a toast library):

```tsx
'use client';
/**
 * Contact-support modal. Optional subject + required message; POSTs to the
 * BFF `/api/support`. Shows inline success / unavailable / error status.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { I } from '../../icons';

export interface SupportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Status = 'idle' | 'sending' | 'success' | 'unavailable' | 'error';

export function SupportDialog({ open, onOpenChange }: SupportDialogProps) {
  const t = useTranslations('support');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>('idle');

  useEffect(() => {
    if (!open) {
      setSubject('');
      setMessage('');
      setStatus('idle');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onOpenChange(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) {
      setStatus('error');
      return;
    }
    setStatus('sending');
    try {
      const res = await fetch('/api/support', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(subject.trim() ? { subject: subject.trim() } : {}),
          message: message.trim(),
        }),
      });
      if (res.status === 201) {
        setStatus('success');
      } else if (res.status === 503) {
        setStatus('unavailable');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-[14px] bg-[var(--bd-card)] border border-[var(--bd-border)] p-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[17px] font-semibold text-[var(--bd-fg)]">{t('title')}</h2>
          <button
            type="button"
            aria-label={t('cancel')}
            onClick={() => onOpenChange(false)}
            className="text-[var(--bd-fg-muted)] hover:text-[var(--bd-fg)]"
          >
            <I.x size={18} />
          </button>
        </div>
        <p className="text-[13px] text-[var(--bd-fg-muted)] mb-4">{t('description')}</p>

        {status === 'success' ? (
          <p className="text-[14px] text-emerald-600">{t('success')}</p>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label htmlFor="support-subject" className="block text-[13px] font-medium mb-1">
                {t('label_subject')}
              </label>
              <input
                id="support-subject"
                value={subject}
                maxLength={200}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={t('placeholder_subject')}
                className="w-full rounded-[10px] border border-[var(--bd-border)] px-3 py-2 text-[14px] bg-transparent"
              />
            </div>
            <div>
              <label htmlFor="support-message" className="block text-[13px] font-medium mb-1">
                {t('label_message')}
              </label>
              <textarea
                id="support-message"
                value={message}
                maxLength={5000}
                rows={5}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t('placeholder_message')}
                className="w-full rounded-[10px] border border-[var(--bd-border)] px-3 py-2 text-[14px] bg-transparent"
              />
            </div>
            {status === 'unavailable' && (
              <p className="text-[13px] text-amber-600">{t('unavailable')}</p>
            )}
            {status === 'error' && <p className="text-[13px] text-rose-600">{t('error')}</p>}
            <button
              type="submit"
              disabled={status === 'sending'}
              className="w-full rounded-[10px] bg-[var(--bd-brand)] text-white py-2.5 text-[14px] font-semibold disabled:opacity-60"
            >
              {status === 'sending' ? t('sending') : t('submit')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
```

Confirm the primary-button + surface classes against `ConsentModal`/existing components; use the repo's tokens (`--bd-*`) as above.

- [ ] **Step 5: Run the dialog test to verify it passes**

Run: `pnpm --filter @aggregator-dpg/web test -- SupportDialog.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Thread `supportEnabled` through auth-context**

In `apps/web/src/lib/auth-context.tsx`, add `supportEnabled` to the context value + `AuthProviderProps` (default `false`), alongside the existing `user`:

```ts
// AuthProviderProps
initialUser?: User | null;
supportEnabled?: boolean;
// context value
supportEnabled: boolean;
```

Set it from the prop (default `false`) and expose it via `useAuth()`. (Match the file's existing shape — it already carries `user`, `signOut`.)

- [ ] **Step 7: Fetch the flag SSR in the protected layout**

In `apps/web/src/app/(protected)/layout.tsx`, after the session checks, fetch support availability server-side (via the BFF `/api/support/config` using the absolute origin, or a direct `apps/api` call with the session token — mirror how the layout/other server components already call the API). Default to `false` on any failure. Pass it to the provider:

```tsx
let supportEnabled = false;
try {
  const r = await callApiServer('/v1/support/config'); // use the repo's server-side authed API helper
  supportEnabled = r.ok ? Boolean((await r.json()).enabled) : false;
} catch {
  supportEnabled = false;
}
// ...
<AuthProvider initialUser={user} supportEnabled={supportEnabled}>
```

Use the same server-side authenticated API-call mechanism the layout already has access to (it holds `session.accessToken`); if none exists, call the BFF route with the incoming cookies. Keep it fail-safe (`false` on error).

- [ ] **Step 8: Add the Sidebar row**

In `apps/web/src/components/shell/Sidebar.tsx`: read `supportEnabled` from `useAuth()`, add `useState` for the dialog, render a **Contact support** row just above the org card `div` (the `mt-auto p-3` block) — only when `supportEnabled` — and render `<SupportDialog>`:

```tsx
const { user, signOut, supportEnabled } = useAuth();
const [supportOpen, setSupportOpen] = useState(false);
// ...before the `mt-auto p-3` org-card block:
{
  supportEnabled && (
    <div className="px-3 pb-1">
      <button
        type="button"
        onClick={() => setSupportOpen(true)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-[10px] text-[14px] font-medium text-[var(--bd-fg-muted)] hover:bg-[var(--bd-border-soft)] hover:text-[var(--bd-fg)] transition-all"
      >
        <I.message size={18} />
        <span>{t('contact_support')}</span>
      </button>
    </div>
  );
}
{
  /* …existing org card… */
}
<SupportDialog open={supportOpen} onOpenChange={setSupportOpen} />;
```

Add `import { useState } from 'react'` and `import { SupportDialog } from '../support/SupportDialog'`. `t` is the `nav` translator already in the file, so `t('contact_support')` resolves the new key.

- [ ] **Step 9: Typecheck + full web tests**

Run: `pnpm --filter @aggregator-dpg/web typecheck && pnpm --filter @aggregator-dpg/web test`
Expected: no type errors; all tests pass.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/support/SupportDialog.tsx apps/web/src/components/support/__tests__/SupportDialog.test.tsx apps/web/src/components/shell/Sidebar.tsx apps/web/src/lib/auth-context.tsx "apps/web/src/app/(protected)/layout.tsx" apps/web/src/i18n/messages/en.json apps/web/src/i18n/messages/hi.json apps/web/src/i18n/messages/kn.json
git commit -m "feat(web): Contact support row + dialog (gated on SUPPORT_EMAIL)"
```

---

### Task 6: Docs / env

**Files:**

- Modify: `infra/env.template`
- Modify: `SETUP.md`

- [ ] **Step 1: Document `SUPPORT_EMAIL` in the env template**

In `infra/env.template`, in the API section (near `ADMIN_EMAILS`), add:

```bash
# Recipient for the in-app "Contact support" form. When unset, the form is
# hidden and POST /v1/support returns 503. Emails send via the configured
# mailer (MAIL_PROVIDER) with Reply-To set to the submitting coordinator.
SUPPORT_EMAIL=
```

- [ ] **Step 2: Note it in `SETUP.md`**

Add a short line under the API/env section:

```markdown
- `SUPPORT_EMAIL` — recipient for the portal "Contact support" form (Sidebar). Unset ⇒ the button is hidden and the endpoint returns 503. Uses the same mailer as registration emails; Reply-To is the submitting coordinator. Locally, mail lands in Mailpit (`:8025`).
```

- [ ] **Step 3: Commit**

```bash
git add infra/env.template SETUP.md
git commit -m "docs: document SUPPORT_EMAIL"
```

---

## Self-Review

**1. Spec coverage:**

- Own-mailer email + `SUPPORT_EMAIL` gating → Tasks 1–3. ✅
- Pure escaped template with full user context → Task 2. ✅
- `POST /v1/support` (authenticated, await + 201/502/503/400/401, Reply-To = submitter) + `GET /v1/support/config` → Task 3. ✅
- BFF proxy (session-token forward) → Task 4. ✅
- Sidebar row (gated), modal (mirror Signals behaviour: optional subject + required message, whitespace-guard, success/unavailable/error), SSR `supportEnabled`, i18n en/hi/kn → Task 5. ✅
- Docs → Task 6. ✅
- Out of scope (audit/metrics) → not implemented. ✅

**2. Placeholder scan:** No TBD/TODO. Code steps carry full code. The "confirm/mirror against `<exact file>`" notes point at named existing files for repo-specific harness details (auth-fake in tests, `renderShell` options, `callApi` signature, server-side authed fetch, `FakeMailer` accessor) — these are real codebase conventions the implementer verifies, not undefined plan content.

**3. Type consistency:** `renderSupportRequest` / `SupportRequestVars` names match between Task 2 and Task 3. `config.SUPPORT_EMAIL` (Task 1) used in Task 3. Error codes `SUPPORT_NOT_CONFIGURED`/`SUPPORT_SEND_FAILED` defined in Task 1, thrown in Task 3. `SupportDialog { open, onOpenChange }` consistent between Tasks 5 steps. `supportEnabled` consistent across auth-context, layout, Sidebar. BFF path `/api/support` matches the dialog's fetch and Task 4.
