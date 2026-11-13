# CLAUDE.md — apps/web

Guidance specific to working inside `apps/web`. Read the root `CLAUDE.md` first — this file covers what's non-obvious once you're actually editing files here.

## Two auth helpers, disjoint usage today — nothing in code stops you picking the wrong one

- **Anonymous**: `getServiceAccessToken()` (`lib/service-token.ts`) does a Keycloak `client_credentials` grant, cached in-process until ~30s before expiry. It's wrapped by `proxyServiceRequest()` (`lib/bff-service-proxy.ts`) and used by exactly 4 routes today: `api/aggregator/register`, `api/org/register`, `api/orgs`, `api/orgs/parents` — genuinely pre-session (registration/listing) endpoints.
- **Authenticated**: `callApi()` (`lib/upstream-client.ts`) reads the Redis session, transparently refreshes the access token 60s before expiry (killing the session on refresh failure), and attaches the caller's own Bearer token. Used by all other API routes plus the protected layout.

**This split is convention-enforced only.** A new authenticated data route wired to `proxyServiceRequest`/`getServiceAccessToken` instead of `callApi` would authorize with the aggregator-wide service-account token rather than the caller's own — the concrete cross-aggregator data-leak shape to watch for. When adding a route: if it needs to know _which_ aggregator/coordinator is calling, it must use `callApi`; only genuinely pre-session registration/lookup endpoints should use the service-token path.

## Session shape and where `auth-context` actually comes from

`SessionStoreBase` (abstract class) has `RedisSessionStore` (prod) + `MemorySessionStore` (test), both taking a `ttlSec` — **`SESSION_TTL_SECONDS` env var, defaulting to 12h** (`lib/session/index.ts:24`), sliding (refreshed on every `get`). `SessionData` holds `sub/email/phone/name` + `accessToken/refreshToken/idToken` + their expiries + `createdAt/lastSeenAt`. `server-session.ts` wraps `getSession()` in React's `cache()` so one Redis hit is shared per request tree.

**`auth-context` is populated server-side, not by a client fetch.** `(protected)/layout.tsx` calls `getSession()` + `tokenAggregatorId()` (a token without `aggregator_id` is not a coordinator: an org owner is redirected to `/console`) + `fetchSupportEnabled()` (`GET /v1/support/config` via `callApi`, fails safe to `false`), then passes both as props into `<AuthProvider initialUser supportEnabled>`. If you're debugging why the UI shows stale auth/support state, look at the layout's server render, not a client-side refetch — there isn't one.

## The organisation console (`(console)/console`, Phase 5)

Org owners and the network admin sign in to the same app and land on `/console` (the callback routes an `org_owner` token there; a coordinator never lands on it). Things that are easy to get wrong:

- **The actor comes from `GET /v1/user/read/me`, not the token.** `lib/console-actor.ts` reads it with the user's token via `callApi` and caches it in the session for ~60 s (`SessionData.consoleActor`); the console layout signs out on `USER_NOT_PROVISIONED` / `NOT_ORG_ADMIN` and sends coordinators to `/dashboard`. The coordinator portal still routes on the `aggregator_id` claim.
- **Screens are server components** reading through `lib/console-api.server.ts`; only mutations go through the BFF, under `app/api/console/*`, all via `lib/console-proxy.ts`: JSON body required (415), **same-origin check** (`lib/same-origin.ts`: `Origin` must equal `PUBLIC_PORTAL_URL`'s origin, else `Sec-Fetch-Site: same-origin`; neither → 403), non-UUID id → 404, then `callApi`. Add any new console mutation the same way; nothing mutates on `GET`. One read goes through the BFF too: `GET /api/console/org/parent/options/:id` (UUID check, then `callApi`), which the org page's Move dialog reads when it opens.
- **Out of reach is a 404 upstream**; pages render `notFound()` for it. A `409 ALREADY_DECIDED` updates the row in place.
- **hi / kn console copy is English** for now (the catalogue test requires the keys), except the invite page (`console.invite.*`), the owner's organisation home (`console.org_home.*`), the coordinator page (`console.coordinator.*`, `console.roles.*`) and the network admin's tiles, list and messages (`console.orgs.tile*`, `view_*`, `error.*`), which are translated.

## `aggregator-schema.server.ts` is the single source for both editable and read-only rendering

Both `/register` and `/profile` call `loadRegistrationSchema()`, which loads `registration.v1.json` + `.ui.json` from `config/schemas/aggregator/` (three-candidate path resolution for dev vs Docker cwd) and patches the `type` enum from `GET /v1/aggregator-config` (falls back silently on error). **The same schema/uiSchema objects** feed both modes:

- **Editable** (`/register`) — rendered as-is.
- **Read-only** (`/profile`, `ProfileFormView.tsx`) — achieved via RJSF's `readonly` prop (not per-field `ui:disabled`), plus a locally-built `readonlyUiSchema` that hides the `consent` block and empties the submit button's children.

`x-updatable` is a custom JSON Schema keyword read directly off `schema.properties[key]['x-updatable'] === true` (`collectUpdatableFields`, `ProfileFormView.tsx:76-79`) to build the "Request an update" panel — **purely config-driven**, no code change needed to add/remove which fields show as updatable. Note the panel is currently UI-only local state (`requestSent` just flips a banner) — there's no backend call behind "Request an update" yet; don't assume one exists when tracing a bug report about it.

## The public registration flow is more than the form — four config-gated surfaces wrap it

`(public)/register` (self-serve) and `[org]/[slug]` (`PublicRegistrationView`, per-link) surround the RJSF form with surfaces that only appear when config enables them; don't assume the form is the whole flow:

- **Pre-form "Already Registered — Sign In" chooser** (#652) — on first open, whenever the Signals hand-off is configured for this domain/mode, the participant chooses **Register** or is sent to the Signals UI to sign in (`SignalsSignInCta`). Config-gated by the same `signals_cta` rule as the hand-off.
- **Post-submit hand-off to the Signals UI** (#654) — on a successful full-profile submission the view redirects to the per-domain Signals login URL from the api's `SIGNALS_UI_URLS` map (parsed + URL-validated at api boot, frozen, surfaced via `/v1/aggregator-config`); no in-app "registration complete" dead-end.
- **On-demand registration QR** (#650) — a link's QR is **derived client-side** in the browser from the public URL (`components/ui/QrCode.tsx`), with no S3 round-trip; the server no longer persists a `qr_object_key`, and legacy rows that still have one return `qr_url: null`.
- **Scroll-gated consent** (#636) — the consent modal only enables acceptance once the participant has scrolled each document to the end (`components/consent/read-progress.ts`), with a small fractional-pixel slack so momentum/overscroll still trips the gate.

**An invalid field never disables Submit (#903).** Disabling Submit until RJSF reports the form valid (#433) left participants facing a dead button with no reason, because field errors only render after a submit attempt. Submit is now gated only on an in-flight submit and the birth-year select; the click runs RJSF's validation, which reveals and focuses every field error and puts `Field: message` lines in the banner. Messages come from `readableFormErrors` (shared `@aggregator-dpg/network-config/field-errors` wording, never a raw regex), and a server 400's `fields.field_errors` is mapped onto the fields via `toErrorSchema` / `extraErrors`. Do not reintroduce a validity-gated Submit without a visible list of what blocks it.

**The form no longer branches on profile lifecycle (#780).** The pre-submit probe still runs, but only `owned_elsewhere` — the identity belongs to ANOTHER aggregator — stops a submission. A participant whose primary is `live`, `draft` or `paused` falls straight through to `allow` and gets a second profile, matching what bulk upload and signals itself have always done (`onboard` without an `item_id` is always an insert, bounded only by `MAX_PROFILES_PER_USER`). The removed `already_registered` banner and the resume prompt are gone with it, along with their en/hi/kn copy. Do not reintroduce a lifecycle branch here: once signals returns items newest-first (signals-dpg#727), "whichever profile signals listed first" is not a stable thing to branch on.

## Consent content has no API round-trip

`(public)/register/page.tsx` loads consent **server-side** via `@aggregator-dpg/config-loader/fs`'s `loadConsentConfig(network, brand)`, extracts each audience's `current_version` doc, and passes typed `ConsentDocContent` as props through `RegisterView` → forms → `ConsentModal`/`MarkdownContent`. Failure degrades to `null` (forms fall back to plain-text labels) rather than throwing — this resolves once per server render, no client-side caching/loading state to reason about.

## This app mostly doesn't follow the packages' abstract-class pattern

`src/services/*` (`profile.service.ts`, `dashboard.service.ts`, etc.) are plain client-side fetch modules, **not** `interface.ts`/abstract-class services — route handlers are the real "service boundary" here. The two places that _do_ follow the repo-wide base-class pattern (`.claude/rules/base-class-pattern.md`) are `lib/oidc/interface.ts` and `lib/session/interface.ts` — treat those two as governed by that rule; everything else under `src/services/` and `src/lib/*-client` files is not.

## Mobile layout (#793 / #817)

The logged-in portal is responsive at the Tailwind `lg` (1024px) breakpoint: below it `components/shell/Sidebar.tsx` hides the sidebar behind a slim menu bar and opens it as a slide-in drawer (Escape / backdrop / link / widen-to-desktop close it; scroll-locked, focus-trapped), and pages reflow for phones. From `lg` up the layout is unchanged, so check both widths when touching the shell or the dashboard.

## Tests

Vitest + jsdom + `@testing-library/react` for components (`src/__tests__/components/*.test.tsx`, one co-located `components/support/__tests__`); plain unit tests for `src/services/__tests__/*.test.ts` (no fake-subpath convention — these are simple fetch wrappers, not abstract-class services). No Playwright/e2e. Coverage thresholds (70/70/60/70) are set in `vitest.config.ts`.

## Next.js specifics

`middleware.ts` is intentionally minimal (Edge runtime can't import `ioredis`) — it only stamps `x-pathname`; all real auth gating happens in `(protected)/layout.tsx` (Node runtime), not middleware.

**This app uses no `NEXT_PUBLIC_*` vars, deliberately.** Next.js inlines them into the client bundle at `next build`, so one read from a client component freezes the value into the image and an operator cannot change it without a rebuild — which is useless for something documented as configuration. Two vars used to be in that trap (`NEXT_PUBLIC_ENABLED_LANGUAGES`, `NEXT_PUBLIC_INVITE_MAX_RECIPIENTS`) and a third (`NEXT_PUBLIC_API_URL`) was a dead build arg the browser never read.

The pattern to follow instead: resolve the value in a **server** component and pass it down.

- Needed by a subtree of client components → resolve once in `app/layout.tsx` and publish via a context provider. `EnabledLocalesProvider` (`src/i18n/EnabledLocalesProvider.tsx`) does this for `ENABLED_LANGUAGES`, since `LanguageSwitcher` renders in four places, three of them inside client components. Its `useEnabledLocales` returns `['en']` (English only) when no provider is above it, which makes the switcher hide itself — chosen over defaulting to every supported locale (that would offer a language the deployment disabled) and over throwing (a blank page for a non-fatal problem).
- Needed by one client component → read it in that route's `page.tsx` and pass a prop, as `register/invite/page.tsx` does for `INVITE_MAX_RECIPIENTS` (and `register/page.tsx` did for the former `ORG_HIERARCHY_ENABLED`, removed in migration 0028).

`FormRuntimeConfigProvider` (`lib/FormRuntimeConfigProvider.tsx`) is the second provider-shaped case: `getFormRuntimeConfig()` (`lib/form-runtime-config.ts`) reads `GOOGLE_MAPS_API_KEY`, `PHOTON_URL`, `GEO_COUNTRY`, `COLLEGE_DATASET` and `REFERENCE_BASE_URL` in a **server** component, and the form widgets take the resolved object from context. `getFormRuntimeConfig()` is server-only in effect — the module itself is `next/*`-free so it stays unit-testable, but calling it from a client component reads an empty `process.env`. Note it treats a **blank** value as absent, because Helm renders an unset value as `""` rather than omitting the variable.

## The form widgets' geo layer (`lib/geo/`)

**Country restriction (signals-dpg#785).** `GEO_COUNTRY` (e.g. `IN`) is passed to the Google Places provider as `includedRegionCodes`, a hard filter. Each suggestion's own `country` component is also checked as a backstop. The Photon provider gets the same restriction (signals-dpg#788): it sends `countrycode`, re-checks each feature's `properties.countrycode` (older Photon servers ignore the param), and drops country- and state-level features. It mirrors Signals' `VITE_GEO_COUNTRY`. Unset, blank or a non-two-letter value means no restriction. The search box only covers picked points: coordinates a registrant or a bulk `geo_location` cell supplies are checked by Signals, which rejects one outside the country with `400 LOCATION_OUTSIDE_COUNTRY` (signals-dpg#789).

Ported from Signals-DPG `apps/ui/src/lib/geo/` and behaviourally the same — read that copy when changing this one, and keep them in step.

- `provider.ts` picks **Google Places** when a maps key is configured and the key-less **Photon** fallback otherwise, wraps it in `withGeoCache` (session suggestion cache + in-flight dedup), and guards every query with `looksLikePIIMask`. The one difference from Signals: configuration arrives per-request from React context rather than `import.meta.env`, so the memo is **keyed on the config it was built from**. Keep that key — the memo is what shares the single Maps JS `<script>` load and the cache across widget mounts.
- `pii-mask.ts` is verbatim from Signals. It exists so the form never geocodes an API-masked value (`"M***"`, `"+91-XX-XXXX-X123"`); a masked query returns `[]` rather than burning quota on nonsense.
- The Google key is a **browser** key and is served to the client by design — restrict it by HTTP referrer at the Google console, and enable **both** Maps JavaScript API and Places API (New); a Places-only restriction blocks the loader script itself.
- The reference datasets are **not committed to this repo**: they are large, always shadowed by a deployment's ConfigMap, and this repo's pre-commit prettier would rewrite a vendored copy out of step with canonical. For local dev point `REFERENCE_BASE_URL` at canonical (`raw.githubusercontent.com` sends `access-control-allow-origin: *`); leave it blank and the institute field is simply a text box.

`getEnabledLocales()` in `src/i18n/config.ts` reads `process.env` and is therefore **server-only in effect** — never call it from a client component. `parseEnabledLocales()` is the pure half if you need the parsing rules elsewhere.
