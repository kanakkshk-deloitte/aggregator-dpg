# Signals UI hand-off from the public registration form — design

Covers **#652** (pre-submit "Already Registered — Sign In" CTA) and **#635**
(post-submit redirect to Signals). Both hand a participant from the aggregator's
public registration page to the Signals UI; both need the same missing piece of
configuration, so the config lands once, in #652.

Related but out of scope: #637 (config-driven profile/voice form toggles),
#651 (re-pointable QR targets), #650 (QR on demand).

---

## 1. Problem

The public registration page (`/<org>/<slug>`) has no way to send a participant
to the Signals UI. Two distinct hand-offs are wanted:

| | Issue | Trigger | Direction |
|---|---|---|---|
| Pre-submit | #652 | User clicks a link under the submit button | Leaves *instead of* submitting |
| Post-submit | #635 | A submit succeeds | Leaves *after* submitting |

Neither is possible today: **no browser-facing Signals UI origin exists anywhere
in this repo.** A grep across `apps/`, `packages/` and `config/` for
`SIGNALS_UI` / `SIGNALS_URL` / `SIGNALS_APP` / `signals_ui_url` returns nothing.
The only adjacent value is `SIGNALSTACK_BASE_URL` (`apps/api/src/config.ts`) —
the server-side **API** base used for outward push. It is not a UI origin and is
never exposed to the browser.

Do not confuse #652 with the **reactive** `already_registered` path, which is
already shipped: `PublicRegistrationView.tsx` runs `runIdentityProbe()` on
submit-attempt and branches to `already_registered` / `owned_elsewhere` /
`resume`. Those render as in-form alert boxes whose CTAs clear the identity
fields for an edit-and-retry. None of them link out. #652 is the *proactive*
"I know I'm registered, take me to sign in" escape hatch.

---

## 2. The URL must be the Signals UI login page, never a Keycloak URL

This is the single most important constraint in this spec, and it is
counter-intuitive enough that it must be called out in the PR description.

The Signals login route is **`/auth/login`** (`Signals-DPG/apps/ui/src/app.tsx`).
There is no `/login` route and no catch-all, so `/login` renders a blank page.

It is tempting to skip the hop and configure the Keycloak authorization URL
directly, e.g.

```
https://test-auth.example/auth/realms/bluedots/protocol/openid-connect/auth
  ?client_id=signals-ui
  &redirect_uri=https%3A%2F%2Fsignals-seeker.example%2Fauth%2Fcallback
  &response_type=code&scope=openid+profile+email
  &state=8364101314c8410e93957a44dadff7be
  &code_challenge=mA7y3a3Ht6LYv4CJX0XHjCX0_AreFZAh7DCdI7U8AS0
  &code_challenge_method=S256
```

**This cannot work.** `Signals-DPG/apps/ui/src/lib/oidc-client.ts` builds that
URL fresh on every attempt via `oidc-client-ts`'s
`userManager.signinRedirect()`. Two of its parameters are one-time values bound
to the browser that minted them:

- **`state`** — a CSRF nonce written to that browser's `WebStorageStateStore`.
  On return, `signinCallback()` compares the returned state against storage. A
  state copied from someone else's session never matches, and login fails.
- **`code_challenge`** — the SHA-256 of a `code_verifier` that only ever existed
  in the originating browser's storage. The token exchange sends the verifier;
  another browser has no matching verifier, so PKCE rejects the exchange.

A pasted Keycloak URL is therefore not "ugly but working" — it is broken for
every user except, once, the person who generated it.

`/auth/login` is precisely the page whose job is to mint a valid one. It reads
the Keycloak authority / realm / client from `GET /api/v1/auth/config` at
runtime (see the comment on `LoginPage` in `login-page.tsx`), then redirects.
Configuring `/auth/login` gets the participant to that same Keycloak screen,
with valid parameters.

**Consequence for operators:** the configured value must be a Signals **UI**
URL. Pointing it at a Keycloak URL produces logins that fail silently. This is
documented in `.env.example` and must be repeated in the PR description.

---

## 3. One Signals UI per domain

A network declares N domains in its upstream `network.json` (`cfg.domainIds`;
`seeker` + `provider` on blue/purple, others elsewhere), and each domain is
fronted by its **own** Signals UI deployment — e.g. a seeker UI and a provider
UI on different hosts. So the config is N domains → N URLs, and the set varies
per network. A future `vendor` domain must be addable without a code change.

---

## 4. Configuration

Two values, in two homes, for two different reasons.

### 4.1 `SIGNALS_UI_URLS` — runtime env (where Signals lives)

Deployment-specific and must be settable at deploy time without an image
rebuild, so it is an env var delivered by the Helm ConfigMap.

```
SIGNALS_UI_URLS=seeker=https://signals-seeker.example/auth/login,provider=https://signals-provider.example/auth/login
```

Format: comma-separated `domain=url` pairs, matching the existing
`CORS_ORIGINS` / `ADMIN_EMAILS` style in `apps/api/src/config.ts`. Adding a
domain is `,vendor=https://...` — no code change.

Parsing rules:
- Split pairs on `,` or newline; tolerate wrapping quotes left by Helm's
  `| quote` (reuse the hardening already in `parseEnvEmailList`).
- Split each pair on the **first** `=` only. URLs legitimately contain `=` in
  query strings; splitting on every `=` would corrupt them.
- Domain key must match `/^[a-z][a-z0-9_]*$/` (the same shape as a domain id).
- Value must parse as an absolute `http:`/`https:` URL.
- A malformed entry is **skipped with a `warn` log naming the key**, not a boot
  crash. This is an optional feature; a typo must not take the API down. It
  must not be silent either.

Values are **full URLs including the path**, not origins, so the hand-off target
can be re-pointed by an env change alone.

### 4.2 `signals_cta` — per-network YAML (which forms get the hand-off)

A product decision, stable across environments, so it belongs in the per-network
config file next to the mode it describes — an extra key on the existing
`registration_modes` block in `config/<network>/aggregator.config.yaml`:

```yaml
registration_modes:
  voice:
    label_i18n_key: registration_mode.voice.label
    submission_shape: account_only
    public_hint_i18n_key: registration_mode.voice.hint
    signals_cta: false
  form:
    label_i18n_key: registration_mode.form.label
    submission_shape: account_and_profile
    public_hint_i18n_key: null
    signals_cta: true
```

`signals_cta` is **optional**. When omitted it defaults to
`submission_shape === 'account_and_profile'`. So with zero config the hand-off
appears on the full-profile form only — the required default — while remaining
per-mode configurable, including for modes that do not exist yet.

Note the codebase has exactly **two** form surfaces, not three:
`account_and_profile` (the full RJSF form, mode `form`) and `account_only`
(`MinimalIdentityForm`, mode `voice`). "Voice" and "account-only" are the same
surface today; `voice` is the only declared mode mapping to `account_only`.
Gating per-mode rather than per-shape means a future third mode (`kiosk`, …)
can differ from `voice` without another schema change.

### 4.3 Why two homes

`SIGNALS_UI_URLS` must change per environment without a rebuild; `signals_cta`
must not drift between environments. `aggregator.config.yaml` is baked into the
image (selected by `AGGREGATOR_NETWORK`; only `consent.json` is ConfigMap-
overlaid), which is right for the second and wrong for the first.

---

## 5. Delivery to the browser

`NEXT_PUBLIC_*` is baked at **build** time and therefore cannot be a deploy-time
knob. The runtime path is the existing config endpoint:

```
ConfigMap env
  → apps/api/src/config.ts          (parse at boot)
  → GET /v1/aggregator-config       (add signals_ui_urls + resolved signals_cta)
  → /api/aggregator-config          (existing unauthenticated BFF proxy)
  → useAggregatorConfig()           (already called by PublicRegistrationView)
  → the CTA / redirect
```

`PublicRegistrationView.tsx` already calls `useAggregatorConfig()` and consumes
`cfg.brand.primary_color`, and the BFF route is explicitly unauthenticated
("every value the upstream returns is operator-public"), so the anonymous public
page already receives a live payload. No new fetch, no new auth surface.

`signals_cta` is **resolved server-side** (default applied) before it ships, so
the client never re-derives the fallback.

`GET /public/v1/aggregators/:orgSlug/links/:slug` needs **no change**: the page
already receives `domain`, `registration_mode` and `submission_shape`, which is
everything needed to pick a URL and decide whether to show the hand-off.

Selection logic on the client:

```
url    = cfg.signals_ui_urls?.[domain]
ctaOn  = cfg.registration_modes?.[registrationMode]?.signals_cta
         ?? (submissionShape === 'account_and_profile')   // mode null/unknown
show   = Boolean(url) && ctaOn
```

A domain with no configured URL simply shows no hand-off. That makes a partial
rollout safe and doubles as the per-domain off switch.

---

## 6. #652 — pre-submit CTA

Layout, per design: consent checkbox → `Submit registration` (primary) →
`Already Registered — Sign In` (tertiary, centred below). Opens in a new tab
(`target="_blank"`, `rel="noopener noreferrer"`) so a half-filled form is not
destroyed.

The CTA renders on **both** form surfaces — gated by `signals_cta`, which by
default means full-profile only. It must still be able to appear on the
account-only form when an operator sets `signals_cta: true` on `voice`, so the
component is passed into `MinimalIdentityForm` as a `footer` prop rather than
duplicated.

Unchanged: the reactive `already_registered` / `owned_elsewhere` / `resume`
alert behaviour.

---

## 7. #635 — post-submit redirect

Fires when `state.status === 'done'` — for **both** outcomes. `passed` is a
fresh registration; `skipped` is a dedup hit meaning "already registered with
this aggregator", for which sending the user to sign in is if anything more
apt.

No instant bounce: the existing green success panel still renders (so the
participant sees confirmation and their reference id), with a visible countdown
— "Redirecting to Signals in 3… 2… 1…" — and a `Continue to Signals` button
that goes immediately. Redirect is same-tab (`window.location.assign`): this is
a completion hop, not an escape hatch.

The existing `Register another` button stays and **cancels the countdown** when
clicked. Without that, an operator registering people back-to-back in the field
would be thrown out of the form after every entry.

Gated by the same `show` expression as #652, so a domain with no URL — or a
mode with `signals_cta: false` — keeps today's behaviour exactly.

---

## 8. Deployment

`bluedots-automation` `helm/aggregator/charts/api/templates/configmap.yaml`
grows a `SIGNALS_UI_URLS` key fed from `values.yaml`. That is a second repo and
ships as its own PR; the aggregator-dpg change is inert until it lands (unset ⇒
no hand-off anywhere).

---

## 9. Sequencing

Two branches, two draft PRs into `feature`, stacked:

1. `feat/652-signals-signin-cta` — all config plumbing + the pre-submit CTA.
2. `feat/635-signals-post-submit-redirect`, branched off #652's branch —
   consumes the same config, adds the countdown redirect. Merges second.

Kept as separate PRs at the issue author's explicit request (comment on #635,
2026-08-20: "#635 and #652 are separate asks and should not be collapsed").
