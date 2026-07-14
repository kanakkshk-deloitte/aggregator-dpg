# Support / contact form (aggregator) — email to configured recipient — design

**Date:** 2026-07-09
**Companion:** mirrors the Signals-DPG support form (signals-dpg #120 / PR #281), adapted to the aggregator stack.
**Labels:** area:api, area:web

## Summary

Add a **Contact support** action to the aggregator coordinator portal's `Sidebar`. Clicking it opens a modal (optional subject + required message). Submitting flows through the Next.js BFF to `apps/api`, which emails the submission — plus the submitter's details — to a configured `SUPPORT_EMAIL` using the aggregator's **own mailer** (`getMailer()`), with Reply-To set to the submitter so support can reply directly.

**Scope:** email-only, mirroring the Signals implementation. No audit record or metrics.

## Design decisions (agreed)

| Decision              | Choice                                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email mechanism       | Reuse the aggregator's own `getMailer()` (SMTP/SES) + a new email template + `SUPPORT_EMAIL` env — **not** the shared notification-service                                                                            |
| Submit path           | Web modal → Next.js BFF route `POST /api/support` (forwards the session token) → fastify `apps/api POST /v1/support` (sends via `getMailer`)                                                                          |
| Button visibility     | **Hidden** when support is unconfigured. Because web and api are separate processes, availability comes from `apps/api` via `GET /v1/support/config`, fetched SSR in the protected layout and passed to the `Sidebar` |
| Form fields           | Optional `subject` + required `message`                                                                                                                                                                               |
| User details in email | name (`preferredUsername`/email), email, phone, user id (`sub`), aggregator id, submitted-at                                                                                                                          |
| Reply-To              | The submitter's email (falls back to the mailer's default `from`)                                                                                                                                                     |
| Delivery              | The endpoint **awaits** the send and confirms success (201) / failure (502)                                                                                                                                           |
| Label / placement     | "Contact support" as a labeled row pinned at the bottom of the `Sidebar`, above the org/sign-out card; `message` icon (no life-buoy in the icon set)                                                                  |

## Background — aggregator stack

- **Web** (`apps/web`, Next.js App Router): protected pages are server components behind a cookie session (`getSession()`, JWT with `aggregator_id`). The `Sidebar` (`components/shell/Sidebar.tsx`) holds nav + the logout button (`useAuth().signOut`). i18n via **next-intl** (`src/i18n/messages/{en,hi,kn}.json`). Modals follow the `ConsentModal` pattern (custom fixed overlay, ESC dismissal, `useTranslations`). Web→api calls go through `app/api/*` BFF route handlers.
- **API** (`apps/api`, Fastify): `authenticate` preHandler (`services/auth/access-token.ts`) yields an `AuthContext` — `userId` (Keycloak `sub`), `aggregatorId`, optional `email`, `phoneNumber`, `preferredUsername`.
- **Mailer** (`apps/api/src/services/mailer`): `getMailer(): MailerAdapter`, `send({ to, subject, html, text, from?, replyTo? }): Promise<MailerResult<SendOk>>` (`{ ok:true, value } | { ok:false, error }`). Provider chosen by `MAIL_PROVIDER` (smtp default / ses). Email templates live in `apps/api/src/services/email-templates/*`, each a pure `renderX(vars) → { subject, html, text }`. `FakeMailer` + `_setMailer` support tests. Recipient lists use the `ADMIN_EMAILS` env pattern.

## Configuration (env, `apps/api`)

- New **`SUPPORT_EMAIL`** (optional) — the recipient for support submissions. Read in `apps/api/src/config.ts`; derived `supportEnabled = Boolean(SUPPORT_EMAIL)`.
- The mailer (SMTP/SES) is already configured for the registration emails and is reused as-is.

`SUPPORT_EMAIL` schema-optional so the api still boots without it; the feature is gated on its presence (button hidden, endpoint 503).

## API (`apps/api`)

### `GET /v1/support/config`

Returns `{ enabled: boolean }` = `supportEnabled`. Lets the SSR web layout decide whether to render the button. `authenticate`-gated (the protected layout already holds the session and forwards it), so no new public surface.

### `POST /v1/support` (authenticated)

- `preHandler: authenticate` (any authenticated coordinator — **not** gated on `requireApproved`, so a pending coordinator can still reach support).
- Body (Zod): `{ subject?: string (≤200), message: string (1–5000, required) }`.
- Handler:
  1. `supportEnabled` false (`SUPPORT_EMAIL` unset) → `503 SUPPORT_NOT_CONFIGURED`.
  2. Build the email via a pure `renderSupportRequest(vars) → { subject, html, text }` (new template in `email-templates/`). Subject: `[Support] {subject || 'New support request'} — {name}`. Body: the message + a details block (name, email, phone, user id, aggregator id, submitted-at). **All user-supplied text (subject, message, name) is HTML-escaped**; the subject is flattened to one line.
  3. `getMailer().send({ to: SUPPORT_EMAIL, replyTo: auth.email ?? <default from>, subject, html, text })`.
  4. **Await** the `MailerResult`: `ok` → `201 { ok: true }`; `!ok` → `502 SUPPORT_SEND_FAILED` (logged via the request logger).
- Registered alongside the other `apps/api` routes.

### Files (API)

- `apps/api/src/services/email-templates/support-request.ts` — `renderSupportRequest` (+ export from the templates index). Pure, HTML-escaping, unit-tested.
- `apps/api/src/routes/support.ts` (or the repo's route-module convention) — `GET /v1/support/config` + `POST /v1/support`.
- `apps/api/src/config.ts` — expose `SUPPORT_EMAIL` / `supportEnabled`.
- Route registration wherever the api mounts route modules.

## Web (`apps/web`)

- **BFF:** `app/api/support/route.ts` — `POST` forwards the request (with the session access token as Bearer) to `apps/api POST /v1/support`, following the existing authenticated BFF proxy pattern; errors returned in the canonical envelope (reuse `bff-errors`). (If the SSR layout fetches config through the BFF, a matching `GET /api/support/config` proxy or a direct server fetch is used.)
- **Support modal:** `components/support/SupportDialog.tsx` — a client modal following the `ConsentModal` pattern (fixed overlay, ESC dismissal, `useTranslations`), with an optional subject input, a required message textarea, and a submit button styled with the portal's primary button classes. Client validation: message required (non-empty after trim, ≤5000). On submit: `POST /api/support`; success → success toast/notice, close + reset; 503 → "unavailable" message; other errors → generic error.
- **Sidebar:** render a **Contact support** labeled row pinned at the bottom of the sidebar, above the org/sign-out card (using the `message` icon — the icon set has no life-buoy), that opens the modal — only when `supportEnabled` is true. The flag is resolved SSR in `(protected)/layout.tsx` (fetch `GET /v1/support/config` / `GET /api/support/config`) and threaded to the `Sidebar` (via `AuthProvider`/props alongside the existing `user`).
- **i18n:** add keys to `apps/web/src/i18n/messages/{en,hi,kn}.json` (next-intl) for the menu item, dialog title/labels/placeholders, submit label, required-field validation, and success/unavailable/error messages.

## Error handling

Machine-readable codes: `SUPPORT_NOT_CONFIGURED` (503), `SUPPORT_SEND_FAILED` (502), body validation (400), unauth (401 via `authenticate`). The endpoint awaits the send so the user gets a real success/failure. API failures logged via the request logger; the BFF maps upstream errors to the canonical envelope.

## Testing

- **Unit — `renderSupportRequest`:** subject formatting (provided + default); html/text contain the message and every detail field; HTML-escaping of subject/message/name; subject newline-flattening; missing email/phone rendered gracefully.
- **API integration (`apps/api`):** authenticated `POST /v1/support` with a `FakeMailer` (`_setMailer`) → asserts `send` called with `to === SUPPORT_EMAIL`, `replyTo === auth.email`, subject/body content; returns 201. `SUPPORT_EMAIL` unset → 503. Mailer returns `{ ok:false }` → 502. Empty message → 400. `GET /v1/support/config` → `{ enabled }`.
- **Web:** the support BFF client (posts to `/api/support`); `SupportDialog` (renders, blocks empty/whitespace message, submits, shows success/unavailable/error); `Sidebar` renders the item only when `supportEnabled`.

## Out of scope (deferred)

- Audit record and metrics (as in Signals — deferred to telemetry).
- Attachments; ticketing/threading/status history.

## Notes / open items to confirm at implementation

- Exact `apps/api` route-registration convention and the Zod/schema style used there.
- The authenticated BFF proxy helper that forwards the session token (a user-token analogue of `bff-service-proxy`), and whether the SSR layout fetches config via a BFF route or a direct server-side fetch.
- Whether `renderX` templates return `text` (plain-text fallback) — `SendInput.text` is required, so `renderSupportRequest` must produce it.
