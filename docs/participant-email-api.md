# Participant Email API (campaign-manager)

**Ticket:** aggregator-dpg#578 · **Umbrella:** Blue-Dots-Economy/signals-dpg#237
**Status:** Implemented on the campaign async-job engine (#579) · **Branch:** `feat/578-participant-email`

Design of record: the two campaign specs on `spec/campaign-async-job-model` —
[API contract normalization](superpowers/specs/2026-08-12-campaign-api-contract-normalization-design.md)
and [async batch processing](superpowers/specs/2026-08-12-campaign-async-batch-processing-design.md).
This document is the email channel's slice of them.

---

## 1. What this is

The campaign-manager application needs to **email participants that its
organisation owns** (e.g. follow-ups). The campaign author composes one message —
a **subject** and a **Markdown body**, optionally with a few **placeholders**
(`{{name}}`, …) — and sends the aggregator a list of **participant references**
(profile item ids). The campaign-manager never sends, and never sees, any email
address.

The aggregator resolves each participant's email **on the server** (from the
encrypted participant store), personalises the message per recipient, and sends
it. The request is **asynchronous**: the API validates it, persists a durable
**campaign job** and returns a `job_id`; a background worker performs the
decrypt + render + send and writes a per-recipient outcome back onto the job,
which the caller polls.

**Personal data never leaves the aggregator.** The caller sends only item ids;
the resolved email addresses (and any other personal fields) are used solely to
build and send the emails, and are never returned to the caller or written to any
caller-visible surface — the poll endpoint reports item ids and statuses only.

---

## 2. Scope

- **Three endpoints:** submit (`POST /v1/campaign/email`), job status
  (`GET /v1/campaign/email/{job_id}`) and job list (`GET /v1/campaign/email`).
- **One shared message**, sent to N owned participants.
- **Optional placeholders** — if the subject/body contains a supported placeholder
  it is replaced with that participant's value; if there are none, the same
  message is sent to everyone. Placeholders are **not** required.
- **Markdown body** → rendered to HTML + a plain-text fallback, sanitised.
- **Per-recipient outcomes are reported**: every item id carries a terminal status
  (`sent` / `skipped_no_contact` / `skipped_not_owned` / `failed`) plus, for a
  successful send, the mailer's message id as `provider_ref`.

**Not in scope here:**

- Email-contact **consent** gating.
- **Profile-field** placeholders beyond the fixed identity set in §5 (see §5.1).
- Attachments; scheduled/delayed send.
- **notification-service delivery.** #578's text says "via notification-service";
  the send goes through the aggregator's own mailer (`@aggregator-dpg/mailer`,
  the same transport as approval/support mail) instead. Accepted deviation,
  recorded on the issue — routing campaign mail through notification-service can
  swap in behind this same job without an API change.

---

## 3. Authentication & authorization

**Token.** Every request carries `Authorization: Bearer <token>` — a Keycloak
access token issued to the campaign-manager application when a campaign-manager
user logs in (interactive OIDC login; the client holds no secret). The token
identifies both the **user** and, via custom claims, the **organisation** they act
for.

**Client scoping (who may call this API).** The endpoint accepts a token **only
if** the token's `azp` claim (the Keycloak client that requested it) is in the
allow-list `CAMPAIGN_MANAGER_ALLOWED_AZP` (default: `campaign-manager`). Tokens
from any other client are rejected with `401`. This client is intentionally kept
out of the aggregator's general token allow-list, so a campaign-manager token is
**only** usable on the campaign endpoints and nowhere else in the aggregator.

**Organisation identity.** The acting organisation is read from the token's
`signalstack_org_id` claim — it is **never** taken from a request header or body.
A token without that claim is rejected with `403`.

**Requesting aggregator.** The aggregator identified by the token's
`aggregator_id` must be `active`, or the request is `403 AGGREGATOR_INACTIVE`.
The job also records a `requested_by` — the token's own verified `email` claim,
falling back to the aggregator's stored `contact_email` — purely as an audit
trail. It is never a destination: this channel resolves every recipient from the
decrypt. If neither resolves the request is `403 RECIPIENT_UNRESOLVED`, because
the column is NOT NULL. All three campaign channels share this behaviour; it
lives in `campaign/submit-job.ts`.

**Ownership (which participants a caller may email).** Ownership is enforced by
the participant store: the decrypt call is scoped to the caller's organisation, so
it returns data **only** for participants that organisation onboarded. Any
requested `item_id` the organisation does not own is recorded
`skipped_not_owned` and never emailed. A caller cannot email participants
belonging to another organisation, even by guessing ids — and the skip reveals
nothing about whether the id exists elsewhere.

---

## 4. API

### `POST /v1/campaign/email`

Validates the request, persists a campaign job (one row per recipient) and
**queues** it. Returns `202` with the `job_id` once the job is durably stored and
enqueued. No personal data is present in the request or the response.

**Headers:** `Idempotency-Key` (optional — a replay returns the same `job_id` and
sends once), `x-request-id` (optional — propagated to the decrypt call as the
correlation id).

**Request body** (`application/json`) — the shared campaign envelope. The
top-level envelope and the `content` block are both **strict** (unknown keys
rejected); `metadata` is an open key/value list by design.

| Field                   | Type                               | Required | Notes                                                                                                                          |
| ----------------------- | ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `item_ids`              | `string[]` (UUID)                  | yes      | The participants to email. 1 … `CAMPAIGN_EMAIL_MAX_ITEMS` (default 200) after de-dup. Over the cap → `400`, never truncated.   |
| `metadata`              | `{ key: string, value: string }[]` | no       | Free-form cross-cutting inputs (e.g. `purpose`, `consent`), stored verbatim on the job. Unknown keys are accepted and ignored. |
| `content.subject`       | `string`                           | yes      | ≤ 200 chars. Plain text. May contain placeholders (§5).                                                                        |
| `content.body_markdown` | `string`                           | yes      | ≤ 20 000 chars. Markdown. May contain placeholders (§5). Rendered on the server.                                               |
| `content.reply_to`      | `string` (email)                   | no       | Sets the email `Reply-To`. The `From` address is always the aggregator's configured sender.                                    |

**Example request**

```jsonc
POST /v1/campaign/email
Authorization: Bearer <campaign-manager access token>
Idempotency-Key: 2026-08-25-q3-followup-1
Content-Type: application/json
{
  "item_ids": [
    "e4e163e7-c4ad-42f9-9550-af6f09267e14",
    "13ccd407-9965-44ff-9d04-2a1561c4f740"
  ],
  "metadata": [{ "key": "purpose", "value": "Q3 follow-up" }],
  "content": {
    "subject": "Hi {{first_name}}, an update on your application",
    "body_markdown": "Hi {{name}},\n\nWe have an **update** for you:\n\n- Step one is complete\n- Step two starts next week\n\nThanks!",
    "reply_to": "campaign@org.example"
  }
}
```

**Success — `202 Accepted`**

```json
{
  "status": "queued",
  "requested": 2,
  "job_id": "9f1c8a52-3d77-4a1e-b0a6-6b3f0e2a91c4",
  "message": "Your campaign email has been queued. Poll GET /v1/campaign/email/{job_id} for per-recipient outcomes."
}
```

> `202` means the job is **durably queued** — not that the emails have been sent.
> Decrypt + send happen asynchronously in the worker; poll for outcomes.

**Error responses**

| HTTP  | `error.code`              | When                                                                                                                                                                                                                                                                   |
| ----- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400` | `SCHEMA_VALIDATION`       | Malformed body: non-UUID / empty `item_ids`, missing `content.subject`/`content.body_markdown`, over-long fields, or unknown keys.                                                                                                                                     |
| `400` | `UNKNOWN_PLACEHOLDER`     | The subject or body contains a `{{token}}` outside the supported set (§5). Fail-closed, so a typo never ships to real inboxes.                                                                                                                                         |
| `400` | `CAMPAIGN_TOO_MANY_ITEMS` | `item_ids` (after de-dup) exceeded `CAMPAIGN_EMAIL_MAX_ITEMS`. `error.fields` reports `max` and `received`.                                                                                                                                                            |
| `401` | `UNAUTHORIZED`            | Token missing / malformed / bad signature or expiry, **or** the token's `azp` is not an allowed campaign-manager client.                                                                                                                                               |
| `403` | `FORBIDDEN`               | Token is valid but lacks the organisation claim (`MISSING_SIGNALSTACK_ORG`) or the aggregator claim (`MISSING_AGGREGATOR_ID`); the requesting aggregator is not `active` (`AGGREGATOR_INACTIVE`); or no requester identity resolves (`RECIPIENT_UNRESOLVED` — see §3). |
| `429` | `CAMPAIGN_RATE_LIMITED`   | Ingress rate-limit for this org tripped (§8). `Retry-After` is set.                                                                                                                                                                                                    |
| `429` | `CAMPAIGN_ACTIVE_LIMIT`   | The org already has `CAMPAIGN_EMAIL_MAX_ACTIVE_PER_ORG` email jobs in flight. Counted per channel — an export job never blocks an email.                                                                                                                               |
| `503` | `EMAIL_ENQUEUE_FAILED`    | The job row was written but could not be queued (e.g. Redis unreachable). A `202` must mean durably queued, so this is surfaced.                                                                                                                                       |

### `GET /v1/campaign/email/{job_id}`

The job's status, derived counts and per-item outcomes. Scoped to the caller's
org **and** to the email channel — another org's job, or a job on another channel,
returns `403` (never a `404` that would confirm the id exists).

```json
{
  "job_id": "9f1c8a52-3d77-4a1e-b0a6-6b3f0e2a91c4",
  "channel": "email",
  "status": "completed",
  "counts": { "total": 2, "pending": 0, "sent": 1, "skipped_no_contact": 1, "failed": 0, "...": 0 },
  "metadata": [{ "key": "purpose", "value": "Q3 follow-up" }],
  "items": [
    {
      "item_id": "e4e163e7-c4ad-42f9-9550-af6f09267e14",
      "status": "sent",
      "provider_ref": "<smtp-message-id>",
      "skip_reason": null,
      "error_reason": null
    },
    {
      "item_id": "13ccd407-9965-44ff-9d04-2a1561c4f740",
      "status": "skipped_no_contact",
      "provider_ref": null,
      "skip_reason": "no_email_address",
      "error_reason": null
    }
  ],
  "created_at": "2026-08-25T09:12:04.001Z",
  "updated_at": "2026-08-25T09:12:07.884Z"
}
```

**Per-item statuses**

| Status               | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pending`            | Not yet acted on (job still queued/processing).                                                                                                                                                                                                                                                                                                                                                                          |
| `sent`               | The mailer accepted the message; `provider_ref` holds its message id.                                                                                                                                                                                                                                                                                                                                                    |
| `skipped_no_contact` | The participant has no email address on file. Not a failure.                                                                                                                                                                                                                                                                                                                                                             |
| `skipped_not_owned`  | The caller's org does not own this item. Not a failure.                                                                                                                                                                                                                                                                                                                                                                  |
| `failed`             | The send was attempted and the mailer rejected it, the template could not be rendered, or Signals did not account for the id. `error_reason` carries a **fixed code** — `INVALID_RECIPIENT`, `TRANSPORT_FAILED`, `AUTH_FAILED`, `render_failed`, `decrypt_missing` or `invalid_email_content`. Never the provider's own message: that routinely quotes the rejected address, and this field is returned by the poll API. |

**Job status** is derived from those counts, never stored as a counter:
`processing` while any item is pending, then `completed` (no failures — skips are
deliberate no-ops, so an all-skipped job still completes), `partial` (a mix) or
`failed` (no successes).

### `GET /v1/campaign/email`

The org's email jobs, newest first, with the same derived counts. Cursor
paginated (`limit`, `cursor` → `next_cursor`). Email jobs only.

---

## 5. Placeholders (fixed set, optional)

Placeholders let the campaign author personalise the message. They are
**optional**: if the subject/body contains one it is replaced per recipient; if it
contains none, the identical message is sent to everyone.

**Supported placeholders** — all resolved from the participant's stored contact
identity:

| Placeholder      | Value                                           |
| ---------------- | ----------------------------------------------- |
| `{{name}}`       | The participant's full name.                    |
| `{{first_name}}` | The first word of the name (for greetings).     |
| `{{last_name}}`  | The remainder of the name after the first word. |
| `{{email}}`      | The participant's own email address.            |
| `{{phone}}`      | The participant's phone number.                 |

**Rules**

- **Syntax:** `{{token}}` (double curly braces). Inner whitespace is tolerated
  and the token is matched case-insensitively, so `{{ name }}`, `{{Name}}` and
  `{{LAST_NAME}}` all resolve normally — a capitalisation slip is not an error.
- **Unknown token → `400 UNKNOWN_PLACEHOLDER`** at submit time (before the job is
  created), naming the offending token — e.g. `{{city}}` or `{{programme}}`.
  `{{ … }}` is therefore reserved syntax in the subject and body.
- **Missing value:** if a supported placeholder has no value for a participant
  (e.g. no name on file), it renders as an **empty string** — the email is still
  sent. Only a missing **email address** skips that recipient
  (`skipped_no_contact`).
- **Minimal data access:** the server only decrypts the fields the message
  actually uses. The recipient email is always needed; `name`/`phone` are decrypted
  only if the corresponding placeholder appears.

**Rendering & safety**

1. The Markdown body is rendered to HTML **once** (the template is shared).
2. The HTML is **sanitised** (scripts, event handlers, and unsafe URLs stripped).
3. For each recipient, each `{{token}}` is replaced with the participant's value —
   **HTML-escaped** in the HTML part (so a value can never inject markup) and used
   verbatim in the plain-text part.

The message structure is author-controlled; the substituted personal values are
always escaped, so decrypted data cannot alter the message structure.

### 5.1 Extra (profile) placeholders — needs input

Anything beyond the identity fields above (e.g. `{{location}}`, `{{program}}` /
applied role, `{{reference_id}}`, `{{status}}`, a date) lives in the participant's
**profile**, and those field names **differ between participant types / networks**.
To avoid exposing arbitrary personal data, these are **not** supported by a generic
mechanism. Instead:

> **Campaign team, please tell us the exact extra fields your emails need.** We
> will add each as a **named, curated placeholder** mapped to the correct profile
> field per participant type (a small config change), rather than allowing free
> access to any field. If the emails only need greetings, the identity set above
> is sufficient.

---

## 6. Body format (Markdown)

- The body is submitted as **Markdown** (`content.body_markdown`). The server
  produces the two parts an email needs:
  - **HTML part** = sanitised HTML rendered from the Markdown, with placeholders
    substituted.
  - **Plain-text part** = the Markdown source with placeholders substituted (it is
    already human-readable).
- Basic formatting — **bold**, paragraphs / blank-line spacing, bulleted lists,
  and links — renders correctly in email clients from the generated HTML.
- Rendering + sanitising live in `packages/campaign-template` (a Markdown renderer
  plus an HTML sanitiser), isolated from the route and the worker. The `content`
  **schema** lives there too (`/content`), so the API's submit-time validation
  and the worker's re-validation of the persisted row assert exactly the same
  thing — including the placeholder allow-list, which the worker re-checks
  before rendering.
- A template that cannot be rendered is treated as deterministic: the recipient
  is recorded `failed`/`render_failed` rather than retried three times.

---

## 7. How it works, end to end

**Phase 1 — API (synchronous, returns `202`):**

1. Authenticate the token and enforce the campaign-manager client gate (§3).
2. Read the acting organisation from the token's `signalstack_org_id` claim
   (`403` if absent), check the aggregator is `active`, and resolve
   `requested_by` (§3).
3. Validate `content` — schema plus the placeholder allow-list
   (`400 UNKNOWN_PLACEHOLDER` on an unknown token) — then de-dup `item_ids` and
   enforce the per-request cap.
4. Apply the ingress rate-limit and the per-org active-job cap (§8).
5. In **one transaction**, insert the `campaign_job` row (channel `email`, the
   `content` block and `metadata` stored verbatim) plus one `campaign_job_item`
   row per recipient, honouring `Idempotency-Key`.
6. Enqueue one `campaign-process` job carrying only the `job_id`, and return
   **`202 { status, requested, job_id, message }`**. If that enqueue fails, the
   committed row is marked `failed`/`enqueue_failed` before the `503`, so it
   cannot sit `queued` forever against the org's active-job cap. The API never
   decrypts or sends.

Steps 1–6 are the shared flow in `campaign/submit-job.ts`, which export and
voice also drive; this channel supplies its own `content` parser, per-channel
config knobs, item `action` and error codes.

**Phase 2 — Worker (asynchronous, the `campaign` role):**

7. Load the job; skip it if it is already terminal, else mark it `processing`.
8. Select the items that are **not** already terminal, and **decrypt** them
   **scoped to the acting organisation** so only owned participants resolve
   (unowned ids → `skipped_not_owned`). Only the contact fields the message uses
   are requested, in `CAMPAIGN_DECRYPT_CHUNK`-sized chunks with a heartbeat per
   chunk. Each chunk is reconciled against what came back: an id Signals returns
   in neither list is recorded `failed`/`decrypt_missing` rather than left
   `pending`, so every item always reaches a terminal status.
9. **Render** the Markdown → sanitised HTML once.
10. **Per recipient:** resolve the email (none → `skipped_no_contact`); substitute
    placeholders; send via the aggregator's mailer (SES/SMTP) with
    `EMAIL_SEND_CONCURRENCY` in flight; write the item's terminal status —
    `sent` (+ the mailer message id as `provider_ref`) or `failed` (+ a fixed
    code). A per-recipient failure never aborts the rest of the batch. The
    watchdog heartbeat also fires periodically **during** the loop, so a long
    batch at bounded concurrency is not false-flagged `stalled` while emails are
    actively going out.
11. Roll the job status up from the item counts. Structured logs carry counts and
    item ids only — **no personal data is logged**.

### Retries and duplicate sends

The job retries like every other campaign job (`CAMPAIGN_EMAIL_ATTEMPTS`,
default 3, exponential backoff) — it is **not** `attempts: 1`. An item already
`sent` is terminal, so a retried job neither decrypts nor re-emails it, and the
item write is forward-only in the store.

**A per-recipient send failure is classified before anything is written:**

| Mailer outcome                     | What happens                                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_RECIPIENT`                | Permanent — the address itself is the problem. Recorded `failed` immediately; no retry could help.                                                                                                                         |
| `TRANSPORT_FAILED` / `AUTH_FAILED` | Transient. **Not** written to the item row while attempts remain: the job throws after the batch finishes, so BullMQ retries it for exactly the recipients still open. On the final attempt the code is recorded `failed`. |

That ordering matters: `failed` is a terminal status, so writing it on attempt 1
would lose a recipient to a one-second transport blip. Throwing _after_ the loop
(rather than from inside it) means every recipient that did succeed is recorded
`sent` first and is therefore excluded from the retry.

**Delivery is at-least-once, per recipient.** The mailer send and the `sent`
status write are two steps; a crash — or a failed status write — between them
leaves the item open and the retry sends again. Neither SMTP nor SES offers an
idempotency key that would close that window, so it is documented rather than
claimed away. The window is small and the alternative (never retrying) loses
recipients outright.

Two failure modes are deliberately distinguished:

- **Transient / infra** (decrypt error, the Signals #521 contact-block guard) —
  re-thrown, so BullMQ retries and the job stays `processing`.
- **Deterministic** (the stored `content` fails re-validation) — every still-
  actionable item is marked `failed` and the job rolls up to `failed`, because a
  retry could not fix it.

---

## 8. Configuration

Per channel by design — the email knobs are never shared with export or voice.

| Setting                                | Default            | Purpose                                                              |
| -------------------------------------- | ------------------ | -------------------------------------------------------------------- |
| `CAMPAIGN_EMAIL_MAX_ITEMS`             | `200`              | Maximum `item_ids` per request (after de-dup); exceeding it → `400`. |
| `CAMPAIGN_EMAIL_SUBMIT_WINDOW_SECONDS` | `60`               | Ingress rate-limit window per org.                                   |
| `CAMPAIGN_EMAIL_SUBMIT_MAX`            | `10`               | Max submits per window per org.                                      |
| `CAMPAIGN_EMAIL_MAX_ACTIVE_PER_ORG`    | `3`                | Max in-flight (`queued`/`processing`) email jobs per org.            |
| `CAMPAIGN_EMAIL_ATTEMPTS`              | `3`                | BullMQ attempts per email job (safe — see the retry note in §7).     |
| `EMAIL_SEND_CONCURRENCY`               | `5`                | Emails sent in parallel within one job (worker).                     |
| `CAMPAIGN_MANAGER_ALLOWED_AZP`         | `campaign-manager` | The Keycloak client(s) permitted on the campaign endpoints.          |

Shared with the rest of the engine: `CAMPAIGN_DECRYPT_CHUNK`,
`CAMPAIGN_STALL_SECONDS`, `CAMPAIGN_CONCURRENCY` (parallel campaign jobs per
worker process — all channels), plus the mail transport
(`MAIL_PROVIDER` + `SMTP_*` / `SES_*`) and `REDIS_URL`.

---

## 9. Acceptance

- Emails are sent only to participants the caller's organisation owns; ids it does
  not own are reported `skipped_not_owned`.
- A participant with no email address is `skipped_no_contact` without failing the
  batch, and a skip never makes the job `partial`.
- Per-recipient outcomes are reported to the caller via the poll endpoint,
  including the mailer's message id for a successful send.
- A retried job never re-emails a recipient already `sent` — verified live: a
  4-recipient job that hit a transport error retried twice and the successful
  recipient's mail was sent exactly once.
- A transport-level failure is retried while attempts remain, and only recorded
  `failed` once they run out (§7).
- No `error_reason` or log line ever carries a recipient address or the mail
  provider's own message.
- The message is rendered on the server; the campaign-manager never receives any
  email address or other personal data.
- A campaign-manager token cannot reach any other aggregator endpoint, and no
  other client can reach this one.
