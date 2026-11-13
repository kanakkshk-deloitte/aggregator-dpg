# config/ — Network and Brand Convention

This directory holds all runtime configuration for the Aggregator DPG stack. Two concepts govern how it is laid out: **network** (the upstream Signals Stack identity) and **brand** (an optional UI/config skin over that network).

---

## Folder layout

```
config/
├── <network>/                         # Standard, brand-agnostic default
│   ├── aggregator.config.yaml         # Core app config for the network
│   ├── brand.json                     # Logo paths pointing to /brand/<network-slug>/
│   ├── keycloak.env                   # Brand strings + colours for Keycloak login
│   └── schemas/                       # RJSF form schemas (aggregator profile, registration)
│       └── aggregator/
│
└── <network>/
    └── <brand>/                       # Self-contained brand copy (full override)
        ├── aggregator.config.yaml
        ├── brand.json                 # Logo paths pointing to /brand/<slug>/
        ├── keycloak.env               # BRAND_LOGO_SLUG=<slug> + overridden strings/colours
        └── schemas/                   # (optional) brand-specific form schemas
```

A brand folder is a **complete copy** of its parent network folder — not a partial override. Every file that exists in the network folder must exist in the brand folder.

### Current networks and brands

| Network      | Standard default     | Brand slug | Brand path                  |
| ------------ | -------------------- | ---------- | --------------------------- |
| `blue_dot`   | `config/blue_dot/`   | `upsdm`    | `config/blue_dot/upsdm/`    |
| `blue_dot`   | `config/blue_dot/`   | `up-gzb`   | `config/blue_dot/up-gzb/`   |
| `orange_dot` | `config/orange_dot/` | `onetac`   | `config/orange_dot/onetac/` |
| `purple_dot` | `config/purple_dot/` | `alimco`   | `config/purple_dot/alimco/` |

`up-gzb` is the Ghaziabad rollout. It is identical to the `blue_dot` defaults
apart from its logo assets, which carry the refreshed Blue Dots lockup
(uppercase wordmark, solid dot, "Seeded by EkStep").

`alimco` is the ALIMCO rollout on `purple_dot`, and is currently a
**byte-identical copy** of the `purple_dot` defaults — a deliberate scaffold
until the team supplies the real branding, legal copy and form fields. Two
values are copies on purpose rather than oversight: `brand.json`'s logo paths
still point at `/brand/purple-dot/`, and `keycloak.env` keeps
`BRAND_LOGO_SLUG=purple-dot`, because no `alimco` asset folder exists under
`apps/web/public/brand/` or in the baked Keycloak theme. Pointing either at
`alimco` before those assets land would serve 404s and an unbranded login
page.

---

## Selector env vars

Two environment variables in `.env` control which config folder is active.

| Variable             | Required | Example    | What it controls                                                               |
| -------------------- | -------- | ---------- | ------------------------------------------------------------------------------ |
| `AGGREGATOR_NETWORK` | Yes      | `blue_dot` | Base network. Drives `SIGNALSTACK_ITEM_NETWORK` and `network.source` upstream. |
| `AGGREGATOR_BRAND`   | No       | `upsdm`    | Brand skin. When set, appends `/<brand>` to all config/Keycloak/schema paths.  |

The api, worker, and web apps **derive** `AGGREGATOR_CONFIG_PATH` and `SCHEMA_ROOT_DIR` at
runtime from these two vars — no need to set the full paths in `.env`. The derivation rule is:

```
dir = CONFIG_ROOT/<AGGREGATOR_NETWORK>[/<AGGREGATOR_BRAND>]
AGGREGATOR_CONFIG_PATH → ${dir}/aggregator.config.yaml
SCHEMA_ROOT_DIR        → ${dir}/schemas
```

`AGGREGATOR_CONFIG_PATH` and `SCHEMA_ROOT_DIR` are still accepted as explicit overrides
(backwards-compatible) when you need to point at a non-standard location.

Docker Compose also mirrors this logic in the `environment:` blocks, passing
`AGGREGATOR_NETWORK`, `AGGREGATOR_BRAND`, and `CONFIG_ROOT=/app/config` to each service.

The effective config root is:

- `AGGREGATOR_NETWORK=blue_dot` (no brand) → `config/blue_dot/`
- `AGGREGATOR_NETWORK=blue_dot AGGREGATOR_BRAND=upsdm` → `config/blue_dot/upsdm/`

### Critical: `SIGNALSTACK_ITEM_NETWORK` always stays the base network

A brand is a **UI/config skin** — it does not change the upstream identity. `SIGNALSTACK_ITEM_NETWORK` is always set to `$AGGREGATOR_NETWORK`, never to `$AGGREGATOR_BRAND`. This means all API calls to the Signals Stack (member lookups, bulk uploads, network attribution) continue to use the base network regardless of which brand is active.

---

## Three asset locations per brand slug

The `BRAND_LOGO_SLUG` value in `keycloak.env` (e.g. `upsdm`) and the `/brand/<slug>/` paths in `brand.json` must all agree. For a slug to work end-to-end, logo assets must exist in three places:

| Location                                                      | Purpose                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `config/<network>/<brand>/`                                   | Config copy — `aggregator.config.yaml`, `brand.json`, `keycloak.env`, `schemas/` |
| `apps/web/public/brand/<slug>/`                               | Web logo assets served by Next.js at `/brand/<slug>/logo.png` etc.               |
| `infra/keycloak/themes/otp/login/resources/img/brand/<slug>/` | Keycloak login page logos                                                        |

---

## How logos are selected

### Web app (runtime)

The web app fetches `brand.json` via the API. The API resolves `brand.json` from the active config path (driven by `AGGREGATOR_NETWORK` + `AGGREGATOR_BRAND`). Logo paths in `brand.json` are relative to Next.js `public/`, so `/brand/upsdm/logo.png` resolves to `apps/web/public/brand/upsdm/logo.png`.

### Keycloak in local docker-compose (runtime)

The Keycloak container mounts the theme from disk (`infra/keycloak/themes`). On each boot it reads `BRAND_LOGO_SLUG` from the selected `keycloak.env` and `template.ftl` uses it to pick the logo at `resources/img/brand/<slug>/`. No rebuild is needed — changing `AGGREGATOR_BRAND` in `.env` and restarting the container switches the brand.

### Keycloak baked k8s theme image (build-time)

For Kubernetes, `build-theme-image.sh` bakes the brand values (including `BRAND_LOGO_SLUG` and all colours/strings) from `keycloak.env` into `theme.properties` at image build time. All slug folders are copied into every image, but the **active slug is frozen per image**. Image tags follow the pattern `aggregator-kc-theme:<network>-<brand>-<tag>`. Deploy the image that matches your intended brand.

```bash
# Build a per-brand theme image
./infra/keycloak/build-theme-image.sh <network> <brand> <tag> [<registry>]

# Examples
./infra/keycloak/build-theme-image.sh blue_dot upsdm v1
./infra/keycloak/build-theme-image.sh orange_dot onetac v1 registry.your.co

# Dry run (prints resolved env_file + image tag, no docker build)
DRY_RUN=1 ./infra/keycloak/build-theme-image.sh blue_dot upsdm v1
```

---

## Adding a new brand

1. **Copy the network config folder** into a brand subfolder:

   ```bash
   cp -a config/<network>/ config/<network>/<newbrand>/
   ```

2. **Set the logo slug** in `config/<network>/<newbrand>/keycloak.env`:

   ```
   BRAND_LOGO_SLUG=<slug>
   ```

3. **Repoint logo paths** in `config/<network>/<newbrand>/brand.json` — change every `/brand/<old-slug>/` to `/brand/<slug>/`.

4. **Add logo assets** in both locations:

   ```bash
   apps/web/public/brand/<slug>/          # logo.png, logo-light.png, etc.
   infra/keycloak/themes/otp/login/resources/img/brand/<slug>/
   ```

5. **For Kubernetes**, build the baked theme image:

   ```bash
   ./infra/keycloak/build-theme-image.sh <network> <newbrand> <tag> [<registry>]
   ```

6. **Deploy** with the two env vars set:

   ```bash
   AGGREGATOR_NETWORK=<network> AGGREGATOR_BRAND=<newbrand> make up
   ```

   The `make check-brand` preflight (run automatically by `make up`) validates that `config/<network>/<newbrand>/` exists before the stack starts. If the folder is missing it exits with an error.

---

## Preflight validation

`make check-brand` (and `make up` which calls it) verifies that when `AGGREGATOR_BRAND` is set the config folder exists:

```bash
make check-brand   # standalone check — no docker activity
make up            # runs check-brand then brings the stack up
```

---

## Registration modes (`aggregator.registration_modes` in `aggregator.config.yaml`)

Per-link capture channels offered on the forms/QR page. The admin dropdown is
rendered straight from these keys, so adding a channel needs no code change —
and removing one stops it being offered on this deployment.

| Key                    | Meaning                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `label_i18n_key`       | Required. i18n key for the mode's label in the admin dropdown.                                                                                                                                                                       |
| `submission_shape`     | `account_and_profile` = identity + full profile form. `account_only` = identity capture only.                                                                                                                                        |
| `public_hint_i18n_key` | Optional copy shown under the public form.                                                                                                                                                                                           |
| `signals_cta`          | Whether this mode offers the Signals UI hand-off — today the pre-submit "Already Registered — Sign In" link; once #635 lands, that mode's post-submit redirect too. Optional; defaults to `submission_shape == account_and_profile`. |

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

### The Signals UI hand-off URL lives in the environment, not here

The hand-off also needs the `SIGNALS_UI_URLS` env var, which maps each domain
to its Signals UI login URL. `SIGNALS_UI_URLS` lives in the environment
(ConfigMap) rather than in this YAML, because it changes per environment while
`signals_cta` must not.

The Signals UI URL configured in `SIGNALS_UI_URLS` must be the Signals UI page
(normally `<origin>/auth/login`) and NOT a Keycloak authorization URL. A
Keycloak authorization URL embeds one-time `state` and PKCE `code_challenge`
values bound to the browser that generated them, so a hardcoded one fails for
every user.

Each key must be a domain id from `network.json`, spelled exactly. A bad entry
never fails boot — it is skipped and warned about in the api startup logs, so
check them after a change. Watch for:

| Problem                                   | Log line says                                                |
| ----------------------------------------- | ------------------------------------------------------------ |
| key names no domain this network declares | `domain "…" is not declared by this network`                 |
| same key twice                            | `duplicate entry for domain "…" — the last one wins`         |
| entry with no `=`                         | `skipping entry with no "=" separator`                       |
| key is not lowercase snake_case           | `skipping entry with invalid domain key`                     |
| value is not a URL, or not http(s)        | `value is not a valid URL` / `only http(s) URLs are allowed` |
