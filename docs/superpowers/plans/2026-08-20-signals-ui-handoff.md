# Signals UI Hand-off Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a participant on the public registration page reach their
domain's Signals UI — before submitting (#652) and after a successful submit
(#635) — driven entirely by per-deployment configuration.

**Architecture:** A new runtime env var `SIGNALS_UI_URLS` maps each network
domain to a full Signals UI login URL; a new optional `signals_cta` flag on each
entry of the existing `registration_modes` block decides which form surfaces get
the hand-off (defaulting to full-profile only). Both reach the browser through
the existing unauthenticated `GET /v1/aggregator-config` → `/api/aggregator-config`
→ `useAggregatorConfig()` path that `PublicRegistrationView` already consumes,
so no new fetch and no new auth surface.

**Tech Stack:** Fastify + Zod (api), Next.js App Router + React + next-intl
(web), Vitest everywhere, pnpm workspaces + turbo.

**Spec:** `docs/superpowers/specs/2026-08-20-signals-ui-handoff-design.md`

## Global Constraints

- Base branch for both PRs: **`feature`**. PR 2 is branched off PR 1's branch and merges second.
- Both PRs open as **draft** (`gh pr create --draft`).
- Configured URLs must be **Signals UI** URLs (`https://host/auth/login`), never Keycloak authorization URLs — a Keycloak URL carries one-time `state` + `code_challenge` values and fails for every user. This must be stated in `.env.example`, in the example config, and in PR 1's description. See spec §2.
- The env value is a **full URL including path**, not an origin.
- Pairs are split on the **first `=` only** — URLs contain `=` in query strings.
- Malformed env entries are skipped with a `warn` log naming the key. Never crash boot; never fail silently.
- `signals_cta` is optional and defaults to `submission_shape === 'account_and_profile'`.
- A domain with no configured URL renders no hand-off, in both features.
- Do not change `GET /public/v1/aggregators/:orgSlug/links/:slug` — it already returns `domain`, `registration_mode` and `submission_shape`.
- Do not change the reactive `already_registered` / `owned_elsewhere` / `resume` alert behaviour.
- Run from the repo root unless a command says otherwise.

---

# PR 1 — #652: pre-submit "Already Registered — Sign In" CTA

Branch: `feat/652-signals-signin-cta` (already created off `origin/feature`).

### Task 1: Parse `SIGNALS_UI_URLS` from the environment

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/.env.example`
- Test: `apps/api/src/config.signals-ui-urls.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function parseSignalsUiUrls(raw: string | undefined): Record<string, string>` and `export const signalsUiUrls: Record<string, string>` from `apps/api/src/config.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/config.signals-ui-urls.test.ts`:

```ts
/**
 * Unit tests for SIGNALS_UI_URLS parsing.
 *
 * Exercised through the exported pure function rather than by mutating
 * process.env, because `config.ts` snapshots the environment at module load.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseSignalsUiUrls } from './config.js';

afterEach(() => vi.restoreAllMocks());

describe('parseSignalsUiUrls', () => {
  it('parses comma-separated domain=url pairs', () => {
    expect(
      parseSignalsUiUrls(
        'seeker=https://signals-seeker.example/auth/login,provider=https://signals-provider.example/auth/login',
      ),
    ).toEqual({
      seeker: 'https://signals-seeker.example/auth/login',
      provider: 'https://signals-provider.example/auth/login',
    });
  });

  it('returns an empty map for unset or empty input', () => {
    expect(parseSignalsUiUrls(undefined)).toEqual({});
    expect(parseSignalsUiUrls('')).toEqual({});
    expect(parseSignalsUiUrls('   ')).toEqual({});
  });

  it('splits on the first = only so query strings survive', () => {
    expect(parseSignalsUiUrls('seeker=https://s.example/auth/login?a=1&b=2')).toEqual({
      seeker: 'https://s.example/auth/login?a=1&b=2',
    });
  });

  it('tolerates Helm quote wrapping, newlines and stray whitespace', () => {
    expect(parseSignalsUiUrls('"seeker=https://s.example/auth/login\n provider=https://p.example/auth/login "')).toEqual(
      {
        seeker: 'https://s.example/auth/login',
        provider: 'https://p.example/auth/login',
      },
    );
  });

  it('skips a malformed entry and warns, keeping the valid ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      parseSignalsUiUrls('seeker=https://s.example/auth/login,provider=not-a-url,=https://x.example,Bad=https://y.example'),
    ).toEqual({ seeker: 'https://s.example/auth/login' });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.flat().join(' ')).toContain('provider');
  });

  it('rejects non-http(s) schemes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSignalsUiUrls('seeker=javascript:alert(1)')).toEqual({});
  });

  it('last entry wins on a duplicate domain key', () => {
    expect(parseSignalsUiUrls('seeker=https://a.example/auth/login,seeker=https://b.example/auth/login')).toEqual({
      seeker: 'https://b.example/auth/login',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/api exec vitest run src/config.signals-ui-urls.test.ts`
Expected: FAIL — `parseSignalsUiUrls` is not exported from `./config.js`.

- [ ] **Step 3: Write the implementation**

In `apps/api/src/config.ts`, add to `ConfigSchema` (place it directly after the `ADMIN_EMAILS` entry):

```ts
  /**
   * Per-domain Signals UI login URLs, as comma-separated `domain=url` pairs:
   *
   *   SIGNALS_UI_URLS=seeker=https://signals-seeker.example/auth/login,provider=https://...
   *
   * Each network domain (from network.json) is fronted by its own Signals UI
   * deployment, so this is a map rather than a single origin. Unset ⇒ the
   * public registration form shows no Signals hand-off at all.
   *
   * The value MUST be a Signals **UI** URL (normally `<origin>/auth/login`),
   * never a Keycloak authorization URL: Keycloak URLs embed one-time `state`
   * and `code_challenge` values bound to the browser that generated them, so a
   * hardcoded one fails PKCE/state validation for every user. `/auth/login` is
   * the page that mints a valid Keycloak URL per attempt.
   */
  SIGNALS_UI_URLS: z.string().default(''),
```

Then, next to `parseEnvEmailList` near the bottom of the file, add:

```ts
/**
 * Parse the `SIGNALS_UI_URLS` env value into a `{ domain: url }` map.
 *
 * Exported (unlike `parseEnvEmailList`) so it can be unit-tested without
 * mutating `process.env`, which `config` snapshots at module load.
 *
 * A malformed entry is dropped with a warning rather than crashing boot: the
 * Signals hand-off is optional, and one typo must not take the API down. The
 * warning keeps it from being a silent failure.
 */
export function parseSignalsUiUrls(raw: string | undefined): Record<string, string> {
  let v = (raw ?? '').trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1).trim();
  }
  const out: Record<string, string> = {};
  for (const entry of v.split(/[,\n]/)) {
    const pair = entry.trim();
    if (!pair) continue;
    // First `=` only — URLs carry `=` inside query strings.
    const eq = pair.indexOf('=');
    const domain = eq === -1 ? '' : pair.slice(0, eq).trim();
    const url = eq === -1 ? '' : pair.slice(eq + 1).trim();
    if (!/^[a-z][a-z0-9_]*$/.test(domain)) {
      console.warn(`SIGNALS_UI_URLS: skipping entry with invalid domain key: "${pair}"`);
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      console.warn(`SIGNALS_UI_URLS: skipping domain "${domain}" — value is not a valid URL`);
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn(`SIGNALS_UI_URLS: skipping domain "${domain}" — only http(s) URLs are allowed`);
      continue;
    }
    out[domain] = url;
  }
  return out;
}

/**
 * Per-domain Signals UI login URLs, parsed once at boot.
 * Empty when unset — the public form then renders no Signals hand-off.
 */
export const signalsUiUrls: Record<string, string> = parseSignalsUiUrls(config.SIGNALS_UI_URLS);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aggregator-dpg/api exec vitest run src/config.signals-ui-urls.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Document it in `.env.example`**

Append to `apps/api/.env.example`:

```
# ── Signals UI hand-off (optional) ───────────────────────────────────────────
# Per-domain Signals UI login URLs as comma-separated `domain=url` pairs. Each
# network domain (see network.json) is fronted by its own Signals UI, so a
# network with N domains needs N entries. Unset => the public registration form
# shows no Signals hand-off.
#
# IMPORTANT: use the Signals **UI** login page, normally <origin>/auth/login.
# Do NOT paste a Keycloak authorization URL here: those embed one-time `state`
# and `code_challenge` values tied to the browser that produced them, so a
# hardcoded one fails for every user. /auth/login mints a valid one per attempt.
# SIGNALS_UI_URLS=seeker=https://signals-seeker.example/auth/login,provider=https://signals-provider.example/auth/login
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/config.signals-ui-urls.test.ts apps/api/.env.example
git commit -m "feat(config): parse per-domain SIGNALS_UI_URLS from the environment"
```

---

### Task 2: Add `signals_cta` to the registration-mode config and resolver

**Files:**
- Modify: `packages/network-config/src/interface.ts` (`RegistrationModeSchema`)
- Modify: `packages/network-config/src/testing.ts` (fixture)
- Modify: `apps/api/src/services/registration-mode/index.ts`
- Test: `apps/api/src/services/registration-mode/index.test.ts`

**Interfaces:**
- Consumes: `ResolvedNetworkConfig` from `@aggregator-dpg/network-config/interface`.
- Produces: `export function signalsCtaEnabled(mode: string, cfg: ResolvedNetworkConfig): boolean` from `apps/api/src/services/registration-mode/index.js`; optional `signals_cta?: boolean` on `RegistrationMode`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/registration-mode/index.test.ts` (and add
`signalsCtaEnabled` to the existing import from `./index.js`):

```ts
describe('signalsCtaEnabled', () => {
  it('defaults to true for an account_and_profile mode with no explicit flag', () => {
    expect(signalsCtaEnabled('form', cfg)).toBe(true);
  });

  it('defaults to false for an account_only mode with no explicit flag', () => {
    expect(signalsCtaEnabled('voice', cfg)).toBe(false);
  });

  it('honours an explicit flag in either direction', () => {
    const explicit = {
      aggregator: {
        registration_modes: {
          voice: { submission_shape: 'account_only', signals_cta: true },
          form: { submission_shape: 'account_and_profile', signals_cta: false },
        },
      },
    } as unknown as ResolvedNetworkConfig;
    expect(signalsCtaEnabled('voice', explicit)).toBe(true);
    expect(signalsCtaEnabled('form', explicit)).toBe(false);
  });

  it('falls back to the resolved shape for an undeclared mode', () => {
    // An undeclared mode already renders the full profile form via
    // resolveSubmissionShape's account_and_profile fallback, so it gets the
    // same hand-off that `form` would.
    expect(signalsCtaEnabled('kiosk', cfg)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/api exec vitest run src/services/registration-mode/index.test.ts`
Expected: FAIL — `signalsCtaEnabled` is not exported.

- [ ] **Step 3: Extend the Zod schema**

In `packages/network-config/src/interface.ts`, add the field to `RegistrationModeSchema`:

```ts
export const RegistrationModeSchema = z.object({
  label_i18n_key: z.string().min(1),
  submission_shape: z.enum(['account_only', 'account_and_profile']),
  public_hint_i18n_key: z.string().min(1).nullable(),
  /**
   * Whether links in this mode offer the Signals UI hand-off (the pre-submit
   * "Already Registered — Sign In" CTA and the post-submit redirect).
   *
   * Optional. When omitted it resolves to
   * `submission_shape === 'account_and_profile'`, so with no config at all the
   * hand-off appears on the full-profile form only. Set explicitly to override
   * per mode — including for modes that do not exist yet.
   */
  signals_cta: z.boolean().optional(),
});
```

- [ ] **Step 4: Implement the resolver**

In `apps/api/src/services/registration-mode/index.ts`, append:

```ts
/**
 * Whether links in this mode offer the Signals UI hand-off.
 *
 * Defaults off the *resolved* submission shape rather than off the raw config,
 * so an undeclared mode — which already renders the full profile form via
 * {@link resolveSubmissionShape}'s fallback — behaves like `form` here too.
 */
export function signalsCtaEnabled(mode: string, cfg: ResolvedNetworkConfig): boolean {
  const modes = cfg.aggregator.registration_modes ?? {};
  const explicit = modes[mode]?.signals_cta;
  if (typeof explicit === 'boolean') return explicit;
  return resolveSubmissionShape(mode, cfg) === 'account_and_profile';
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @aggregator-dpg/api exec vitest run src/services/registration-mode/index.test.ts`
Expected: PASS.

- [ ] **Step 6: Keep the shared fixture representative**

In `packages/network-config/src/testing.ts`, add `signals_cta: false` to the
`voice` entry and `signals_cta: true` to the `form` entry of
`registration_modes`, so downstream route tests exercise explicit values rather
than only the derived defaults.

- [ ] **Step 7: Verify the package still builds and its own tests pass**

Run: `pnpm --filter @aggregator-dpg/network-config test && pnpm --filter @aggregator-dpg/network-config exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/network-config/src/interface.ts packages/network-config/src/testing.ts apps/api/src/services/registration-mode/
git commit -m "feat(network-config): optional signals_cta flag per registration mode"
```

---

### Task 3: Expose both values on `GET /v1/aggregator-config`

**Files:**
- Modify: `apps/api/src/routes/aggregator-config.ts`
- Test: `apps/api/src/routes/aggregator-config.test.ts`

**Interfaces:**
- Consumes: `signalsUiUrls` (Task 1), `signalsCtaEnabled` (Task 2).
- Produces: response fields `signals_ui_urls: Record<string,string>` (top level) and a resolved boolean `signals_cta` on every `registration_modes` entry.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('GET /v1/aggregator-config')` block in
`apps/api/src/routes/aggregator-config.test.ts`:

```ts
  it('exposes signals_ui_urls (empty when the env var is unset)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    const body = res.json() as { signals_ui_urls: Record<string, string> };
    expect(body.signals_ui_urls).toEqual({});
  });

  it('resolves signals_cta on every registration mode', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    const body = res.json() as {
      registration_modes: Record<string, { signals_cta: boolean }>;
    };
    expect(body.registration_modes.form?.signals_cta).toBe(true);
    expect(body.registration_modes.voice?.signals_cta).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/api exec vitest run src/routes/aggregator-config.test.ts`
Expected: FAIL — `body.signals_ui_urls` is `undefined`; `signals_cta` is `undefined`.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/aggregator-config.ts`:

Add the imports:

```ts
import { signalsUiUrls } from '../config.js';
import { signalsCtaEnabled } from '../services/registration-mode/index.js';
```

Extend the `RegistrationMode` shape used by `PublicAggregatorConfig` so its
`registration_modes` value type includes `signals_cta: boolean`, then add to
the `PublicAggregatorConfig` interface, after `registration_modes`:

```ts
  /**
   * Per-domain Signals UI login URLs, keyed by domain id. Empty when the
   * deployment has not configured any — the public form then shows no Signals
   * hand-off. Sourced from the SIGNALS_UI_URLS env var, not from the YAML, so
   * it can be changed at deploy time without an image rebuild.
   */
  signals_ui_urls: Record<string, string>;
```

Extend `AggregatorConfigResponseSchema`: change the `registration_modes` value
schema to `z.object({ label: z.string().optional(), signals_cta: z.boolean() }).passthrough()`
and add a sibling:

```ts
    signals_ui_urls: z.record(z.string(), z.string()),
```

In the handler, replace the `registration_modes` line and add the new field:

```ts
        registration_modes: Object.fromEntries(
          Object.entries(cfg.aggregator.registration_modes ?? {}).map(([key, mode]) => [
            key,
            // Resolve the default server-side so the client never re-derives it.
            { ...mode, signals_cta: signalsCtaEnabled(key, cfg) },
          ]),
        ),
        signals_ui_urls: signalsUiUrls,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aggregator-dpg/api exec vitest run src/routes/aggregator-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole api suite for regressions**

Run: `pnpm --filter @aggregator-dpg/api test`
Expected: PASS. The response schema is `.passthrough()`, so no other route test should break.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/aggregator-config.ts apps/api/src/routes/aggregator-config.test.ts
git commit -m "feat(api): expose signals_ui_urls and resolved signals_cta on aggregator-config"
```

---

### Task 4: Mirror the new fields in the web config hook

**Files:**
- Modify: `apps/web/src/hooks/useAggregatorConfig.ts`

**Interfaces:**
- Consumes: the wire format from Task 3.
- Produces: `RegistrationModeConfig.signals_cta?: boolean` and `AggregatorConfigPayload.signals_ui_urls?: Record<string, string>`.

- [ ] **Step 1: Extend the types**

In `apps/web/src/hooks/useAggregatorConfig.ts`, add to `RegistrationModeConfig`:

```ts
  /**
   * Whether links in this mode offer the Signals UI hand-off. Resolved
   * server-side (the `submission_shape` default is already applied), so the
   * client reads it directly. Optional for back-compat with an older api build.
   */
  signals_cta?: boolean;
```

and to `AggregatorConfigPayload`, after `registration_modes`:

```ts
  /**
   * Per-domain Signals UI login URLs, keyed by domain id. Absent or missing a
   * domain ⇒ no Signals hand-off for that domain.
   */
  signals_ui_urls?: Record<string, string>;
```

`DEFAULT_AGGREGATOR_CONFIG` is deliberately left unchanged: both fields are
optional, and the cold-mount default must not advertise a hand-off that the
deployment may not have configured.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/useAggregatorConfig.ts
git commit -m "feat(web): type signals_ui_urls and signals_cta on the aggregator config"
```

---

### Task 5: Add the CTA copy to all three locales

**Files:**
- Modify: `apps/web/src/i18n/messages/en.json`
- Modify: `apps/web/src/i18n/messages/hi.json`
- Modify: `apps/web/src/i18n/messages/kn.json`

**Interfaces:**
- Produces: message key `profile.public_reg.signals_cta`, resolved by `useTranslations('profile.public_reg')`.

- [ ] **Step 1: Add the key to each locale file**

Under `profile.public_reg`, alongside `btn_submit`, add:

- `en.json`: `"signals_cta": "Already Registered — Sign In"`
- `hi.json`: `"signals_cta": "पहले से पंजीकृत हैं — साइन इन करें"`
- `kn.json`: `"signals_cta": "ಈಗಾಗಲೇ ನೋಂದಾಯಿಸಲಾಗಿದೆ — ಸೈನ್ ಇನ್ ಮಾಡಿ"`

Only these three locale files exist, even though `config/features.yaml` lists
`te` and `ta` as available — that gap predates this work; do not create new
locale files here.

- [ ] **Step 2: Verify all three files still parse and have the key**

Run:
```bash
for f in apps/web/src/i18n/messages/*.json; do
  python3 -c "import json,sys; d=json.load(open('$f')); assert d['profile']['public_reg']['signals_cta']; print('$f ok')"
done
```
Expected: three `ok` lines.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/i18n/messages/
git commit -m "feat(i18n): add the Signals sign-in CTA copy in en, hi and kn"
```

---

### Task 6: Render the CTA on both form surfaces

**Files:**
- Create: `apps/web/src/app/[org]/[slug]/SignalsSignInCta.tsx`
- Modify: `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx`
- Modify: `apps/web/src/app/[org]/[slug]/MinimalIdentityForm.tsx`
- Test: `apps/web/src/__tests__/views/PublicRegistrationView.signals-cta.test.tsx` (create)

**Interfaces:**
- Consumes: `useAggregatorConfig()` (Task 4), message key from Task 5.
- Produces: `export function useSignalsHandoffUrl(domain: string, registrationMode: string | null, submissionShape: 'account_only' | 'account_and_profile'): string | null` and `export function SignalsSignInCta({ href }: { href: string })`, both from `./SignalsSignInCta`. PR 2 reuses `useSignalsHandoffUrl` unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/views/PublicRegistrationView.signals-cta.test.tsx`.
Copy the RJSF shim and the provider wrapper from the existing
`PublicRegistrationView.lookup.test.tsx` (read it first — mirror its
`vi.mock('@/components/forms/RjsfThemed', …)` shim and its
`NextIntlClientProvider` + `QueryClientProvider` render helper verbatim), then
mock the config hook per test:

```tsx
// Config drives the CTA entirely; each test supplies its own payload.
const cfgMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({ data: cfgMock.value }),
  DEFAULT_AGGREGATOR_CONFIG: cfgMock.value,
}));

const CFG = {
  aggregator: { name: 'Test' },
  brand: { short_name: 'Blue Dots', long_name: 'Blue Dots', url_slug: 'bd', primary_color: '#2563EB' },
  network: { id: 'blue_dot' },
  domains: [{ id: 'seeker', label: 'Seeker', plural_label: 'Seekers', item_type: 'profile_1.0' }],
  registration_modes: {
    form: { label_i18n_key: 'x', submission_shape: 'account_and_profile', public_hint_i18n_key: null, signals_cta: true },
    voice: { label_i18n_key: 'y', submission_shape: 'account_only', public_hint_i18n_key: null, signals_cta: false },
  },
  signals_ui_urls: { seeker: 'https://signals-seeker.example/auth/login' },
};

describe('Signals sign-in CTA', () => {
  it('renders on the full-profile form and opens the domain URL in a new tab', () => {
    cfgMock.value = CFG;
    renderView({ domain: 'seeker', registrationMode: 'form', submissionShape: 'account_and_profile' });
    const link = screen.getByRole('link', { name: /already registered/i });
    expect(link).toHaveAttribute('href', 'https://signals-seeker.example/auth/login');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('is absent when the mode has signals_cta false', () => {
    cfgMock.value = CFG;
    renderView({ domain: 'seeker', registrationMode: 'voice', submissionShape: 'account_only' });
    expect(screen.queryByRole('link', { name: /already registered/i })).toBeNull();
  });

  it('is absent when the domain has no configured URL', () => {
    cfgMock.value = { ...CFG, signals_ui_urls: {} };
    renderView({ domain: 'seeker', registrationMode: 'form', submissionShape: 'account_and_profile' });
    expect(screen.queryByRole('link', { name: /already registered/i })).toBeNull();
  });

  it('renders on the account-only form when signals_cta is explicitly enabled for voice', () => {
    cfgMock.value = {
      ...CFG,
      registration_modes: { ...CFG.registration_modes, voice: { ...CFG.registration_modes.voice, signals_cta: true } },
    };
    renderView({ domain: 'seeker', registrationMode: 'voice', submissionShape: 'account_only' });
    expect(screen.getByRole('link', { name: /already registered/i })).toBeInTheDocument();
  });

  it('falls back to the submission shape when the mode is unknown to the config', () => {
    cfgMock.value = CFG;
    renderView({ domain: 'seeker', registrationMode: 'kiosk', submissionShape: 'account_and_profile' });
    expect(screen.getByRole('link', { name: /already registered/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/__tests__/views/PublicRegistrationView.signals-cta.test.tsx`
Expected: FAIL — no matching link is rendered.

- [ ] **Step 3: Create the component and the selection hook**

Create `apps/web/src/app/[org]/[slug]/SignalsSignInCta.tsx`:

```tsx
'use client';

/**
 * Pre-submit escape hatch (#652): a tertiary link under the submit button for
 * a participant who already has a Signals account and does not want to fill
 * the form.
 *
 * Distinct from the reactive `already_registered` alert, which fires on a
 * submit-attempt after the identity probe and offers edit-and-retry. This one
 * is proactive and leaves the page.
 */

import { useTranslations } from 'next-intl';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';

/**
 * Resolve the Signals UI URL for this link, or `null` when the hand-off is off.
 *
 * Two independent gates, both config-driven:
 *  - the link's registration mode must have `signals_cta` (resolved
 *    server-side; defaults to full-profile modes only), and
 *  - the link's domain must have a URL in `signals_ui_urls`.
 *
 * The returned value is a full URL configured by the operator — normally the
 * Signals UI's `/auth/login`, which mints a fresh Keycloak authorization URL
 * per attempt. A Keycloak URL configured here would carry one-time `state` and
 * `code_challenge` values and fail for every user; see the note in .env.example.
 */
export function useSignalsHandoffUrl(
  domain: string,
  registrationMode: string | null,
  submissionShape: 'account_only' | 'account_and_profile',
): string | null {
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const url = cfg.signals_ui_urls?.[domain];
  if (!url) return null;
  const mode = registrationMode ? cfg.registration_modes?.[registrationMode] : undefined;
  // No declared mode (older api build, or a mode this network dropped) falls
  // back to the shape, matching the server-side default.
  const enabled = mode?.signals_cta ?? submissionShape === 'account_and_profile';
  return enabled ? url : null;
}

export function SignalsSignInCta({ href }: { href: string }) {
  const t = useTranslations('profile.public_reg');
  return (
    <div className="mt-4 text-center">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[13.5px] font-semibold text-ink-500 underline underline-offset-4 hover:text-ink-700"
      >
        {t('signals_cta')}
      </a>
    </div>
  );
}
```

- [ ] **Step 4: Accept a footer slot on the account-only form**

In `apps/web/src/app/[org]/[slug]/MinimalIdentityForm.tsx`, add `footer?: React.ReactNode;`
to the props interface with the comment:

```tsx
  /**
   * Rendered directly beneath the submit button. Used for the Signals sign-in
   * CTA, which is owned by PublicRegistrationView so the config lookup lives
   * in one place for both form surfaces.
   */
```

and render `{props.footer}` immediately after the `<button type="submit">` element.

- [ ] **Step 5: Wire it into both surfaces**

In `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx`:

Import it:

```tsx
import { SignalsSignInCta, useSignalsHandoffUrl } from './SignalsSignInCta';
```

Call the hook next to the other top-level hooks (near line 178, after
`useAggregatorConfig`) — hooks must not sit behind the account-only early
return at line 551:

```tsx
  const signalsHandoffUrl = useSignalsHandoffUrl(domain, registrationMode, submissionShape);
```

Pass it to the account-only form in the early-return branch:

```tsx
            footer={signalsHandoffUrl ? <SignalsSignInCta href={signalsHandoffUrl} /> : null}
```

And render it directly after the full-profile submit button — inside the same
wrapper `<div>` that closes just before `</RjsfThemedForm>`:

```tsx
                      {signalsHandoffUrl && <SignalsSignInCta href={signalsHandoffUrl} />}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/__tests__/views/PublicRegistrationView.signals-cta.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 7: Run the full web suite plus lint and typecheck**

Run: `pnpm --filter web test && pnpm --filter web lint && pnpm --filter web exec tsc --noEmit`
Expected: PASS. `MinimalIdentityForm.test.tsx` and `PublicRegistrationView.lookup.test.tsx` must still pass — `footer` is optional.

- [ ] **Step 8: Commit**

```bash
git add "apps/web/src/app/[org]/[slug]/" apps/web/src/__tests__/views/PublicRegistrationView.signals-cta.test.tsx
git commit -m "feat(web): add the Already Registered sign-in CTA to the public registration form"
```

---

### Task 7: Set `signals_cta` in every network config and document it

**Files:**
- Modify: `config/blue_dot/aggregator.config.yaml`
- Modify: `config/blue_dot/upsdm/aggregator.config.yaml`
- Modify: `config/purple_dot/aggregator.config.yaml`
- Modify: `config/orange_dot/onetac/aggregator.config.yaml`
- Modify: `config/aggregator.config.example.yaml`
- Modify: `config/README.md`

**Interfaces:**
- Consumes: the schema from Task 2.

- [ ] **Step 1: Add the flag to the four configs that declare registration modes**

In each of the four files, add `signals_cta: false` to the `voice` entry and
`signals_cta: true` to the `form` entry. Written explicitly rather than relying
on the derived default so the file documents the behaviour on its face.

`config/orange_dot/aggregator.config.yaml` declares no `registration_modes`
block and needs no change — it already resolves to `form`-only via the schema
default.

- [ ] **Step 2: Document the whole block in the example config**

`config/aggregator.config.example.yaml` currently does not mention
`registration_modes` at all — that omission is why the feature reads as
"not config-driven". Add, after the `onboarding` block:

```yaml
  # ── Registration modes ─────────────────────────────────────────────────────
  # Per-link capture channels offered on the forms/QR page. The admin dropdown
  # is rendered straight from these keys, so adding a channel needs no code
  # change — and removing one stops it being offered on this deployment.
  #
  #   submission_shape      account_and_profile = identity + full profile form
  #                         account_only        = identity capture only
  #   public_hint_i18n_key  optional copy shown under the public form
  #   signals_cta           whether this mode offers the Signals UI hand-off
  #                         (the "Already Registered — Sign In" link and the
  #                         post-submit redirect). Optional; defaults to
  #                         `submission_shape == account_and_profile`.
  #
  # The hand-off also needs the SIGNALS_UI_URLS env var, which maps each domain
  # to its Signals UI login URL. Use the Signals UI page (normally
  # <origin>/auth/login) — NOT a Keycloak authorization URL, which embeds
  # one-time state/PKCE values and fails for every user.
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

- [ ] **Step 3: Cross-reference from the config README**

Add a short `registration_modes` section to `config/README.md` mirroring the
example's comments, and state that `SIGNALS_UI_URLS` lives in the environment
(ConfigMap) rather than in this YAML, because it changes per environment while
`signals_cta` must not.

- [ ] **Step 4: Verify every config still loads against the schema**

Run: `pnpm --filter @aggregator-dpg/network-config test && pnpm --filter @aggregator-dpg/api test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add config/
git commit -m "feat(config): declare signals_cta per registration mode and document the block"
```

---

### Task 8: Open the draft PR

- [ ] **Step 1: Full verification before claiming done**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS. Paste the real tail of the output into the PR body — do not
claim green without it.

- [ ] **Step 2: Push and open the draft PR**

```bash
git push -u origin feat/652-signals-signin-cta
gh pr create --draft --base feature \
  --title "feat(registration): Already Registered — Sign In CTA on the public form (#652)" \
  --body-file /dev/stdin <<'EOF'
Closes #652.

## What changed

Adds a tertiary "Already Registered — Sign In" link beneath `Submit registration`
on the public participant registration form, linking to the Signals UI for the
link's domain. Renders only when configured, so it is off by default everywhere.

- `SIGNALS_UI_URLS` env var — comma-separated `domain=url` pairs, one per
  network domain, parsed at api boot. Runtime config so it can be set at deploy
  time without an image rebuild.
- `signals_cta` — a new optional flag on each `registration_modes` entry in
  `config/<network>/aggregator.config.yaml`. Defaults to
  `submission_shape == account_and_profile`, i.e. full-profile form only.
- Both surfaced on the existing unauthenticated `GET /v1/aggregator-config`,
  which the public form already reads. No new endpoint, no new auth surface,
  and no change to `GET /public/v1/aggregators/:org/links/:slug`.
- `config/aggregator.config.example.yaml` documents `registration_modes` for the
  first time.

## ⚠️ The configured URL must be a Signals UI URL, never a Keycloak URL

Configure `<signals-origin>/auth/login`. It is tempting to skip the hop and
point straight at the Keycloak authorization URL, e.g.
`…/protocol/openid-connect/auth?client_id=signals-ui&state=…&code_challenge=…`.

**That cannot work.** Signals builds that URL fresh per attempt via
`oidc-client-ts` (`apps/ui/src/lib/oidc-client.ts`), and two of its parameters
are one-time values bound to the browser that generated them:

- `state` is a CSRF nonce written to that browser's storage; on return,
  `signinCallback()` compares the returned value against storage, so a copied
  state never matches.
- `code_challenge` is the SHA-256 of a `code_verifier` that only ever existed in
  the originating browser; another browser has no matching verifier, so PKCE
  rejects the token exchange.

A pasted Keycloak URL works exactly once, for the person who generated it, and
fails silently for everyone else. `/auth/login` is the page whose job is to mint
a valid one — it reads the Keycloak authority/realm/client from
`GET /api/v1/auth/config` at runtime and redirects.

Note also that Signals has **no `/login` route** and no catch-all, so `/login`
renders a blank page. The path is `/auth/login`.

## Not to be confused with

- The reactive `already_registered` / `owned_elsewhere` / `resume` alerts, which
  fire on a submit-attempt and offer edit-and-retry. Unchanged by this PR.
- #635 — the post-submit redirect. Stacked on this branch, merges second.

## Deployment

Needs a companion `bluedots-automation` ConfigMap change to set
`SIGNALS_UI_URLS`. Until that lands this is inert: unset ⇒ no CTA anywhere.

## Testing

<!-- paste the real `pnpm lint && pnpm typecheck && pnpm test` tail here -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

---

# PR 2 — #635: post-submit redirect with countdown

Branch off PR 1's branch, **after** Task 8:

```bash
git checkout -b feat/635-signals-post-submit-redirect feat/652-signals-signin-cta
```

### Task 9: Redirect to Signals after a successful submit

**Files:**
- Modify: `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx`
- Modify: `apps/web/src/i18n/messages/{en,hi,kn}.json`
- Test: `apps/web/src/__tests__/views/PublicRegistrationView.signals-redirect.test.tsx` (create)

**Interfaces:**
- Consumes: `useSignalsHandoffUrl` from `./SignalsSignInCta` (Task 6) — unchanged.

- [ ] **Step 1: Add the copy to all three locales**

Under `profile.public_reg`:

- `en.json`: `"signals_redirect_notice": "Redirecting to Signals in {seconds}…"`, `"btn_continue_to_signals": "Continue to Signals"`
- `hi.json`: `"signals_redirect_notice": "{seconds} सेकंड में Signals पर ले जाया जा रहा है…"`, `"btn_continue_to_signals": "Signals पर जारी रखें"`
- `kn.json`: `"signals_redirect_notice": "{seconds} ಸೆಕೆಂಡುಗಳಲ್ಲಿ Signals ಗೆ ಕರೆದೊಯ್ಯಲಾಗುತ್ತಿದೆ…"`, `"btn_continue_to_signals": "Signals ಗೆ ಮುಂದುವರಿಸಿ"`

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/__tests__/views/PublicRegistrationView.signals-redirect.test.tsx`,
reusing the RJSF shim, render helper and `cfgMock` from
`PublicRegistrationView.signals-cta.test.tsx`. Drive the submit through the
shim, stub `fetch` to return a successful submit, use `vi.useFakeTimers()`, and
stub navigation:

```tsx
const assign = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});
afterEach(() => vi.useRealTimers());

it('counts down from 3 and then navigates to the domain URL', async () => {
  cfgMock.value = CFG;
  await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
  expect(screen.getByText(/Redirecting to Signals in 3/)).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(screen.getByText(/Redirecting to Signals in 2/)).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(assign).toHaveBeenCalledWith('https://signals-seeker.example/auth/login');
});

it('navigates immediately when Continue to Signals is clicked', async () => {
  cfgMock.value = CFG;
  await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
  fireEvent.click(screen.getByRole('button', { name: /continue to signals/i }));
  expect(assign).toHaveBeenCalledWith('https://signals-seeker.example/auth/login');
});

it('cancels the countdown when Register another is clicked', async () => {
  cfgMock.value = CFG;
  await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
  fireEvent.click(screen.getByRole('button', { name: /register another/i }));
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(assign).not.toHaveBeenCalled();
});

it('redirects on a dedup hit (outcome=skipped) too', async () => {
  cfgMock.value = CFG;
  await submitSuccessfully({ domain: 'seeker', registrationMode: 'form', status: 409, outcome: 'skipped' });
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(assign).toHaveBeenCalled();
});

it('keeps the plain success panel when the domain has no configured URL', async () => {
  cfgMock.value = { ...CFG, signals_ui_urls: {} };
  await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
  expect(screen.queryByText(/Redirecting to Signals/)).toBeNull();
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(assign).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/__tests__/views/PublicRegistrationView.signals-redirect.test.tsx`
Expected: FAIL — no countdown text is rendered.

- [ ] **Step 4: Implement the countdown**

In `PublicRegistrationView.tsx`, add state next to the other `useState` calls:

```tsx
  // #635: post-submit hand-off. `null` = no countdown running. Kept separate
  // from `state` so cancelling the redirect (Register another) does not have
  // to reconstruct the submit result.
  const [redirectIn, setRedirectIn] = useState<number | null>(null);
```

Start it when the submit lands, and tick it down:

```tsx
  // Arm the countdown once a submit succeeds and the hand-off is configured.
  // Both outcomes qualify: `passed` is a new registration, `skipped` is a dedup
  // hit meaning "already registered here", for which signing in is if anything
  // more apt.
  useEffect(() => {
    if (state.status !== 'done' || !signalsHandoffUrl) return;
    setRedirectIn(SIGNALS_REDIRECT_SECONDS);
  }, [state.status, signalsHandoffUrl]);

  useEffect(() => {
    if (redirectIn === null || !signalsHandoffUrl) return;
    if (redirectIn <= 0) {
      window.location.assign(signalsHandoffUrl);
      return;
    }
    const timer = setTimeout(() => setRedirectIn((n) => (n === null ? null : n - 1)), 1000);
    return () => clearTimeout(timer);
  }, [redirectIn, signalsHandoffUrl]);
```

with, near the other module-level constants:

```tsx
/** Grace period before the post-submit hand-off fires, so the participant
 *  actually sees the success panel and their reference id (#635). */
const SIGNALS_REDIRECT_SECONDS = 3;
```

In the `state.status === 'done'` panel (around line 644), render the notice and
the button above the existing `Register another` button:

```tsx
                {redirectIn !== null && signalsHandoffUrl ? (
                  <>
                    <p aria-live="polite" className="text-[13px] text-emerald-700 mt-4">
                      {t('signals_redirect_notice', { seconds: redirectIn })}
                    </p>
                    <button
                      type="button"
                      onClick={() => window.location.assign(signalsHandoffUrl)}
                      style={{ backgroundColor: cfg.brand.primary_color }}
                      className="mt-3 w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white hover:opacity-90 transition-opacity"
                    >
                      {t('btn_continue_to_signals')}
                    </button>
                  </>
                ) : null}
```

and cancel the countdown in the existing `Register another` handler by adding
`setRedirectIn(null);` alongside its current `setState({ status: 'idle' })`.
Without that cancel, an operator registering people back-to-back in the field
is thrown out of the form after every entry.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/__tests__/views/PublicRegistrationView.signals-redirect.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 6: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit, push, open the stacked draft PR**

```bash
git add "apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx" apps/web/src/i18n/messages/ apps/web/src/__tests__/views/PublicRegistrationView.signals-redirect.test.tsx
git commit -m "feat(registration): redirect to Signals after a successful submit"
git push -u origin feat/635-signals-post-submit-redirect
gh pr create --draft --base feat/652-signals-signin-cta \
  --title "feat(registration): post-submit redirect to the Signals UI (#635)" \
  --body "Closes #635. **Stacked on #652 — merge that first**, then retarget this to \`feature\`.

On a successful submit the existing green success panel still renders, then a
visible countdown (\"Redirecting to Signals in 3… 2… 1…\") hands the participant
to their domain's Signals UI. A \`Continue to Signals\` button goes immediately;
\`Register another\` cancels the countdown so field operators registering people
back-to-back are not thrown out of the form.

Fires for both submit outcomes: \`passed\` (new registration) and \`skipped\` (a
dedup hit meaning the person is already registered with this aggregator, for
which signing in is if anything more apt).

Reuses \`useSignalsHandoffUrl\` and the \`SIGNALS_UI_URLS\` / \`signals_cta\`
config introduced in #652 — no new configuration. A domain with no configured
URL, or a mode with \`signals_cta: false\`, keeps today's behaviour exactly.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

# Follow-up (separate repo, not blocking)

`bluedots-automation` needs `SIGNALS_UI_URLS` plumbed through:

- `helm/aggregator/charts/api/templates/configmap.yaml`: add
  `SIGNALS_UI_URLS: "{{ .Values.global.signalsUiUrls }}"`
- `helm/aggregator/values.yaml`: add `signalsUiUrls: ''` under `global`, with a
  comment carrying the same Signals-UI-not-Keycloak warning.

Confirm with the user before opening a PR against that repo.

---

## Self-review

**Spec coverage.** §2 (Keycloak warning) → Tasks 1, 7, 8. §3 (per-domain) →
Task 1. §4.1 (`SIGNALS_UI_URLS`) → Task 1. §4.2 (`signals_cta`) → Tasks 2, 7.
§5 (delivery to browser) → Tasks 3, 4. §6 (#652 CTA) → Tasks 5, 6. §7 (#635
redirect) → Task 9. §8 (deployment) → Follow-up. §9 (sequencing) → Tasks 8, 9.

**Type consistency.** `useSignalsHandoffUrl(domain, registrationMode, submissionShape)`
is defined in Task 6 and consumed unchanged in Task 9. `signalsCtaEnabled(mode, cfg)`
is defined in Task 2 and consumed in Task 3. `parseSignalsUiUrls` / `signalsUiUrls`
are defined in Task 1 and consumed in Task 3. Wire field names `signals_ui_urls`
and `signals_cta` are identical in Tasks 3, 4 and 6.

**Known deviation to confirm during review.** Task 9 keeps `Register another`
and makes it cancel the countdown. That is a deliberate addition beyond #635's
literal text; if the reviewer disagrees, deleting the cancel is a one-line change.
