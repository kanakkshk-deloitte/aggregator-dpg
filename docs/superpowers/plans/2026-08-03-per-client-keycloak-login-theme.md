# Plan: distinguish the signals and aggregator login pages

**Status:** Implemented — see §10 for the verification record
**Date:** 2026-08-03
**Scope:** changes in `aggregator-dpg` only. signals-dpg keeps its single `otp`
theme unchanged — it is the only theme its standalone stack needs.
**Companion:** `2026-07-29-aggregator-keycloak-integration-plan.md` (the Phase B
realm merge that created this problem)

> Point-in-time record. Where this plan and the repo disagree later, the repo wins.

---

## 1. The problem

Phase B merged both DPGs' clients into one `bluedots` realm served by one
Keycloak container (`local-setup/docker-compose.yml`, service `sd-keycloak`).
The login theme is set **at realm level** — `"loginTheme": "otp"`
(`infra/keycloak/realms/realm.json:25`) — so every client renders the same page,
and all brand values come from a single container env set fed by
`config/<network>/keycloak.env`. One container, one brand, one page.

Verified live against the running stack: the authorization endpoint for
`client_id=signals-ui` returns a page themed `otp`, with wordmark "Blue Dots"
and

```html
<title>Sign in to Blue Dots Aggregator Portal</title>
```

A participant signing in to **Signals** is told they are signing in to the
**Aggregator Portal**. That is the bug, not just a cosmetic overlap.

Both apps hand off login entirely to this page — signals-ui's own comment calls
sign-in "a pure hand-off" (`signals-dpg/apps/ui/src/pages/auth/keycloak-login-panel.tsx:56`)
— so the Keycloak page is the _only_ login surface either app has.

## 2. The lever, and what it costs

Keycloak supports a **per-client login theme override**: the client attribute
`login_theme`. Different clients on the same realm, same flow, can render
different themes.

**The OTP flow does not change at all.** `bluedots-otp-browser`, the SPI jar and
the authenticator configs are realm-level and shared. This is purely theme
resolution.

Two limits to accept up front:

- **`emailTheme` has no per-client override** — it is realm-only. The OTP email
  stays shared between both apps. Its copy is already app-neutral
  (`emailOtpSubject=Your verification code`), so this is tolerable; see §6.
- The realm default `loginTheme` still applies to everything without an
  explicit override (account console, other clients).

## 3. Verified: theme inheritance carries resources

The design below rests on a child theme inheriting templates, CSS, JS and images
from a custom parent. Confirmed empirically against the running `sd-keycloak`:

```
GET /resources/l9s9k/login/otp/css/styles.css      → 200, 3064 bytes
GET /resources/l9s9k/login/otp/img/favicon.ico     → 200,  627 bytes
GET /resources/l9s9k/login/otp/css/nonexistent.css → 404
```

The `otp` theme's own `resources/css/` contains **only** `blue-dots.css`;
`styles.css` and `favicon.ico` resolve up the chain to `keycloak.v2`/`base`. A
genuinely missing file still 404s, so this is real chain resolution, not a
catch-all. A child theme therefore needs **no** copied assets.

## 4. Design

Keep `themes/otp/` as the aggregator theme, exactly as it is. Add one thin child
theme for signals that inherits everything and overrides only brand values.

This means **zero changes** to `config/*/keycloak.env`, `build-theme-image.sh`,
the `keycloak-theme-build.yaml` workflow, or any helm build-arg — all of which
key off the `otp` name and the `BRAND_*` variables.

### 4.1 New file: `infra/keycloak/themes/signals/login/theme.properties`

```properties
parent=otp

# Every brand key the parent defines MUST be overridden here — properties
# inherit, so an unset key silently falls through to aggregator's value.
# Defaults are signals-flavoured so the theme is correct with no env plumbing.
brandShortName=${env.SIGNALS_BRAND_SHORT_NAME:Blue Dots}
brandLongName=${env.SIGNALS_BRAND_LONG_NAME:Blue Dots Signals}
brandAppLabel=${env.SIGNALS_BRAND_APP_LABEL:Signals Network}
brandSsoLabel=${env.SIGNALS_BRAND_SSO_LABEL:SSO}
brandLogoSlug=${env.SIGNALS_BRAND_LOGO_SLUG:blue-dot}
heroTitleLead=${env.SIGNALS_HERO_TITLE_LEAD:Welcome to}
heroTitleHighlight=${env.SIGNALS_HERO_TITLE_HIGHLIGHT:the Signals network}
heroTitleTail=${env.SIGNALS_HERO_TITLE_TAIL:}
heroSubtitle=${env.SIGNALS_HERO_SUBTITLE:Sign in to discover and connect across the network.}
brandFontSans=${env.SIGNALS_BRAND_FONT_SANS:Arial, system-ui, sans-serif}
brandFontHeading=${env.SIGNALS_BRAND_FONT_HEADING:Arial, system-ui, sans-serif}
brandFontBody=${env.SIGNALS_BRAND_FONT_BODY:Arial, system-ui, sans-serif}
brandPrimary=${env.SIGNALS_BRAND_PRIMARY_COLOR:#0074ff}
brandPrimaryDark=${env.SIGNALS_BRAND_PRIMARY_DARK:#005ecc}
brandPrimary500=${env.SIGNALS_BRAND_PRIMARY_500:#57abff}
brandPrimary100=${env.SIGNALS_BRAND_PRIMARY_100:#cfe6ff}
brandPrimary50=${env.SIGNALS_BRAND_PRIMARY_50:#e6f0ff}
```

Because the defaults are baked, **no compose or env-file change is required**
for this to render correctly. The `SIGNALS_*` vars exist only as optional
per-network overrides, mirroring the `BRAND_*` set.

> **Known fall-through risk.** A brand key added to `otp` later and not added
> here will silently render aggregator's value on the signals page. The
> alternative — refactoring `otp` into a brandless `otp-base` with two children
> — removes the risk but touches `themes.Dockerfile`, the build script, the CI
> workflow and every helm build-arg. Not worth it for this change; noted so the
> tradeoff is a choice rather than an oversight. Revisit if a third theme
> appears.

### 4.2 Two back-compatible edits to `themes/otp/login/template.ftl`

Both are shared by the parent and the child, and both no-op when the new
property is absent — so aggregator's rendering is byte-identical to today.

1. **Title** (`template.ftl:10`) reads `realm.displayName`, which is
   realm-wide and is exactly what produces "Sign in to Blue Dots Aggregator
   Portal" on the signals page. Change to prefer the theme property:

   ```ftl
   <title>${msg("loginTitle",(properties.brandLongName!realm.displayName!''))}</title>
   ```

   Aggregator is unaffected — its `brandLongName` is already
   `Blue Dots Aggregator Portal`, matching the realm displayName.

2. **App-label pill** under the logo (after `template.ftl:65`) — the single
   highest-signal differentiator, and it also fixes the wrong-door case where
   someone lands on the wrong app's login:

   ```ftl
   <#if (properties.brandAppLabel!'')?has_content>
       <span class="bd-app-label">${properties.brandAppLabel}</span>
   </#if>
   ```

   Plus a `.bd-app-label` rule in `resources/css/blue-dots.css` (small pill,
   `var(--bd-primary-50)` background, `var(--bd-primary)` text). Add
   `brandAppLabel=${env.BRAND_APP_LABEL:Aggregator Portal}` to `otp`'s
   `theme.properties` so aggregator gets a label too.

### 4.3 Realm export: one attribute

In `infra/keycloak/realms/realm.json`, the `signals-ui` client's existing
`attributes` block (line 541) gains:

```json
"login_theme": "signals"
```

`aggregator-portal` needs nothing — the realm default `loginTheme: "otp"`
already resolves to the aggregator theme. Setting it explicitly is optional
clarity, not a requirement.

### 4.4 Init script: apply to already-imported realms

The realm JSON is **only read on first import** — every existing volume would
never see the attribute. `infra/keycloak/init/apply-user-profile.sh` is the
established idempotent post-boot fixup for exactly this, and its section 5
(line 372+) already resolves and PUTs the `signals-ui` client for the acting-org
mapper. Add a section 6 alongside it that GETs the client, sets
`attributes["login_theme"] = "signals"`, PUTs it back, and re-reads to verify —
matching the "verify rather than trust" pattern the script uses throughout
(see its comment at line 117).

### 4.5 Kubernetes theme image

`infra/keycloak/themes.Dockerfile` stages the theme into a shared emptyDir with:

```dockerfile
CMD ["sh", "-c", "... cp -aT /custom/otp /shared/otp ..."]
```

It copies **only `otp`**, so the new `signals` theme would never reach the
volume in k8s and the override would silently fall back to the realm default.
Change the copy to stage the whole tree (both theme dirs), keeping the existing
`ls` sanity check.

Optionally add a second `printf` block baking `SIGNALS_*` literals into
`/custom/signals/login/theme.properties`, the same way the file already bakes
aggregator's — only needed if signals branding must vary per network. The baked
defaults from §4.1 are otherwise sufficient.

## 5. Sequencing

| #   | Change                           | Files                                                                                                   |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Child theme                      | `infra/keycloak/themes/signals/login/theme.properties` (new)                                            |
| 2   | Template + CSS + parent property | `themes/otp/login/template.ftl`, `.../resources/css/blue-dots.css`, `themes/otp/login/theme.properties` |
| 3   | Client override                  | `infra/keycloak/realms/realm.json`                                                                      |
| 4   | Existing-realm fixup             | `infra/keycloak/init/apply-user-profile.sh`                                                             |
| 5   | k8s staging fix                  | `infra/keycloak/themes.Dockerfile`                                                                      |
| 6   | Neutral OTP sender (§6)          | `local-setup/docker-compose.yml`                                                                        |

Steps 1–3 are the functional change; 4 and 5 are what makes it hold outside a
fresh local volume. All six are one PR.

## 6. The shared OTP email

One realm sends both apps' OTP mails and `emailTheme` cannot be overridden per
client, so the email must stay app-neutral. Its body copy already is. But
`local-setup/docker-compose.yml` sets

```yaml
SMTP_FROM_DISPLAY: ${SMTP_FROM_DISPLAY:-Blue Dots Aggregator}
```

which mislabels every signals OTP mail. Change the default to a neutral
`Blue Dots`. (Aggregator's own standalone `docker-compose.yml` serves only
aggregator, so its value can stay.)

Genuinely per-app email branding needs either separate realms — which
`signals-dpg/docs/2026-07-29-keycloak-realm-topology-feedback.md` already argues
for on unrelated grounds — or an SPI change passing the client into the email
attributes. Both are out of scope here.

## 7. Verification

1. `docker compose -f local-setup/docker-compose.yml down -v && up -d` (the
   realm only imports into a fresh volume).
2. Signals login renders the signals theme, titled "Sign in to Blue Dots
   Signals", with a "Signals Network" pill:
   ```
   curl -s "http://localhost:8080/realms/bluedots/protocol/openid-connect/auth\
   ?client_id=signals-ui&response_type=code&scope=openid\
   &redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F\
   &code_challenge_method=S256&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" \
     | grep -E '<title>|bd-app-label|resources/[^/]+/login/'
   ```
   The `resources/.../login/signals/` path in the output is the proof the
   override took effect.
3. Aggregator portal login is **unchanged** from today — same title, same
   palette, plus the new "Aggregator Portal" pill.
4. Complete one full OTP login end-to-end per app (phone via
   `docker compose logs -f keycloak | grep -i otp`, email via Mailpit on :8025)
   to confirm the flow is untouched.
5. Without `down -v`: confirm the init script alone flips an existing realm
   (re-run it and check the client attribute).

## 8. Consequence for signals-dpg

Per the scope decision, signals-dpg is untouched — its standalone stack imports
its own realm with `loginTheme: "otp"` and mounts its own theme tree, so it
keeps working exactly as now.

The side effect: the two repos' theme trees have been **byte-identical** to date
(`diff -rq` clean) and are hand-mirrored, a rule stated in
`signals-dpg/infra/keycloak/README.md:27-29`. After this change they diverge
deliberately — aggregator's `otp/login/template.ftl`, `blue-dots.css` and
`theme.properties` gain the app-label and title changes.

Those three edits are all back-compatible and safe to copy across, so the
mirroring rule still holds in one direction. Worth a one-line note in that
README (a signals-dpg change, not part of this PR) so nobody later "restores
parity" by reverting them.

## 9. Open design questions

### 9.1 The hero copy properties are dead — differentiation is thinner than expected

Found while verifying: `heroTitleLead`, `heroTitleHighlight`, `heroTitleTail`,
`heroSubtitle` and `brandSsoLabel` are **rendered by no template**. `grep` across
every `.ftl` in the theme returns zero hits; the hero pane shows only
`brandShortName` as a wordmark plus a hardcoded "Seeded by EkStep Foundation"
strapline (`template.ftl:57-58`).

They are nonetheless plumbed through 12 references in `config/*/keycloak.env` and
`keycloak-theme-build.yaml`, plus `themes.Dockerfile` ARGs — so every network's
carefully-written hero strings are inert today. **Pre-existing, not introduced
here**, but it means the differentiation this change actually delivers is the
`<title>` and the app-label pill, not the hero copy the plan originally assumed.

Two ways forward, both a design call rather than a mechanical one:

- **Activate them** — ~6 lines in `template.ftl` renders a headline and subtitle
  in the hero pane. Makes the two pages plainly distinct and makes the existing
  per-network config do something. But it visibly changes the aggregator login
  page, which is a live surface.
- **Delete them** — drop the dead keys from the theme, the env files, the
  Dockerfile ARGs and the workflow, and accept the wordmark-only hero.

Leaving them dead is the one option with no upside.

### 9.2 Palette

Both apps currently resolve to the same `--bd-primary: #0074ff` — signals by the
new theme's default, aggregator because `config/blue_dot/keycloak.env` sets that
same canonical Blue Dots blue. So the accent does **not** distinguish them.
Whether it should is a brand call; the property is in place either way, so it is
a one-line change once decided.

## 10. Implementation record

Shipped as described, with these files touched:

| File                                                          | Change                                             |
| ------------------------------------------------------------- | -------------------------------------------------- |
| `infra/keycloak/themes/signals/login/theme.properties`        | New — the whole child theme, one file              |
| `infra/keycloak/themes/otp/login/theme.properties`            | `brandAppLabel` added                              |
| `infra/keycloak/themes/otp/login/template.ftl`                | `<title>` prefers `brandLongName`; app-label pill  |
| `infra/keycloak/themes/otp/login/resources/css/blue-dots.css` | `.bd-app-label`                                    |
| `infra/keycloak/realms/realm.json`                            | `login_theme: signals` on `signals-ui`             |
| `infra/keycloak/init/apply-user-profile.sh`                   | Section 6, `ensure_login_theme`                    |
| `infra/keycloak/themes.Dockerfile`                            | `BRAND_APP_LABEL` arg; stages the whole theme tree |
| `local-setup/docker-compose.yml`                              | Neutral `SMTP_FROM_DISPLAY` (both keycloak + init) |

### Verified against the running `sd-keycloak` (26.5.5)

**Theme inheritance carries everything.** The `signals` theme owns exactly one
file on disk (`theme.properties`), yet all of these resolve through the parent
chain:

```
/resources/l9s9k/login/signals/css/blue-dots.css        200  17552b
/resources/l9s9k/login/signals/js/blue-dots.js          200   6195b
/resources/l9s9k/login/signals/img/brand/blue-dot/logo.png  200  61651b
/resources/l9s9k/login/signals/css/styles.css           200   3064b   (from keycloak.v2)
```

**The two pages now differ.** Both endpoints return 200:

|                | `signals-ui`                     | `aggregator-portal`                        |
| -------------- | -------------------------------- | ------------------------------------------ |
| theme resolved | `login/signals/`                 | `login/otp/`                               |
| `<title>`      | Sign in to Blue Dots **Signals** | Sign in to Blue Dots **Aggregator Portal** |
| app-label pill | Signals Network                  | Aggregator Portal                          |
| `--bd-primary` | `#0074ff`                        | `#0074ff` (identical — see §9.2)           |

Before the change, `signals-ui` rendered `login/otp/` titled "Sign in to Blue
Dots Aggregator Portal".

**The init-script section behaves.** Run against the live realm: applies on first
run, reports "already 'signals' — skip" on the second, and skips a non-existent
client without failing (exit 0). Post-PUT the client retained
`pkce.code.challenge.method`, `post.logout.redirect.uris`, all three
`redirectUris` and all four protocol mappers — the `jq` merge does not clobber.

`bash -n` and `sh -n` (the alpine runtime) both pass; `realm.json` is valid JSON.

**Not verified:** the k8s init-container path (`themes.Dockerfile`) — no cluster
to hand. The change is a copy-scope widening with an `ls` guard on both theme
dirs, so a staging failure surfaces as a failed init container rather than a
silent fallback, but it wants a real deploy before promotion.

**Local-stack side effect:** the verification set `login_theme` on the running
realm's `signals-ui` client. That is the intended end state and matches what
`apply-user-profile.sh` now does on every `up`, so nothing needs undoing.
