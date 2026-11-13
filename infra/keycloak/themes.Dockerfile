# Init-container image that ships the Keycloak `otp` theme plus per-
# network brand values baked into `theme.properties` and `template.ftl`.
#
# Pattern: at pod start, this image runs as an initContainer, copies
# `/custom` into a shared emptyDir, then exits. The main Keycloak
# container mounts the same emptyDir at `/opt/keycloak/themes`, so the
# Keycloak image stays vanilla while every per-deployment string is
# frozen into the theme image hash.
#
# Build (one image per network):
#   docker build -f infra/keycloak/themes.Dockerfile \
#     --build-arg NETWORK=purple_dot \
#     --build-arg BRAND_SHORT_NAME='Purple Dots' \
#     --build-arg BRAND_LONG_NAME='Purple Dot Aggregator Portal' \
#     --build-arg BRAND_PRIMARY_COLOR='#A855F7' \
#     --build-arg BRAND_PRIMARY_DARK='#7C3AED' \
#     --build-arg BRAND_PRIMARY_500='#A855F7' \
#     --build-arg BRAND_PRIMARY_100='#EDE9FE' \
#     --build-arg BRAND_PRIMARY_50='#F5F3FF' \
#     --build-arg BRAND_HERO_BG='#1E1B4B' \
#     --build-arg BRAND_HERO_GRAD='#C4B5FD' \
#     --build-arg HERO_TITLE_LEAD='Welcome to' \
#     --build-arg HERO_TITLE_HIGHLIGHT='Purple Dots' \
#     --build-arg HERO_TITLE_TAIL='discovery & services for people with disabilities.' \
#     --build-arg HERO_SUBTITLE='Sign in to manage beneficiaries, service providers, and onboarding across the network.' \
#     --build-arg EMAIL_SIGNOFF='Team ALIMCO' \
#     -t registry.your.co/aggregator-kc-theme:purple-v1 .
#
# Or simpler — pass `--build-arg-file config/<network>/keycloak.env`.

# Docker Hardened Image. Same busybox 1.38, but it runs as `nonroot` (uid 65532)
# instead of root — which is the whole point, since this init container runs
# inside the Keycloak pod. busybox still provides sh/cp/mkdir/ls/printf, so both
# the RUN below and the CMD keep working.
FROM dhi.io/busybox:1.38-alpine

ARG NETWORK=blue_dot
ARG BRAND_SHORT_NAME=Aggregator
ARG BRAND_LONG_NAME=Aggregator Portal
ARG BRAND_SSO_LABEL=SSO
# Names the app on the login page. The realm is shared with signals, whose
# `signals` child theme sets its own — without this the two are indistinguishable.
ARG BRAND_APP_LABEL=Aggregator Portal
ARG BRAND_PRIMARY_COLOR=#4f46e5
ARG BRAND_PRIMARY_DARK=#4338ca
ARG BRAND_PRIMARY_500=#6366f1
ARG BRAND_PRIMARY_100=#e0e7ff
ARG BRAND_PRIMARY_50=#eef2ff
ARG BRAND_HERO_BG=#0f172a
ARG BRAND_HERO_GRAD=#7dd3fc
ARG HERO_TITLE_LEAD=Welcome to
ARG HERO_TITLE_HIGHLIGHT=the Aggregator
ARG HERO_TITLE_TAIL=portal.
ARG HERO_SUBTITLE=Sign in to manage participants, registrations, and onboarding for your network.
# brand.json-driven values (PR #355). Slug + font stack get baked
# into theme.properties so the runtime never falls back to default.
ARG BRAND_LOGO_SLUG=purple-dot
# Hero-panel lockup: a filename inside img/brand/<BRAND_LOGO_SLUG>/, or empty to
# keep the wordmark + strapline text. Empty by default because onetac and
# orange-dot ship no logo-on-brand.png and would render a broken image.
ARG BRAND_HERO_LOGO=
# Strapline under the hero wordmark. Quoted for the same reason as
# EMAIL_SIGNOFF below — an unquoted default truncates at the first space.
# Blank it for a brand whose lockup artwork already carries the strapline.
ARG BRAND_SEEDED_BY="Seeded by EkStep Foundation"
ARG BRAND_FONT_SANS=Inter, system-ui, sans-serif
ARG BRAND_FONT_HEADING=Plus Jakarta Sans, system-ui, sans-serif
ARG BRAND_FONT_BODY=Inter, system-ui, sans-serif
# Sign-off on the login-OTP email (#626). The email theme's copy is otherwise
# static, but this line differs per network (EkStep on Blue Dot, ALIMCO on
# Purple Dot), so it is rebaked below from the network's keycloak.env like the
# brand strings are. The default matches the checked-in messages_en.properties,
# which is what the compose stack (mounting the theme tree directly) uses.
# NB the quotes: an unquoted Dockerfile ARG default truncates at the first
# space (the brand ARGs above have the same latent flaw, harmless only
# because build-theme-image.sh always passes a keycloak.env that overrides
# them). Without them this default bakes as "Team".
ARG EMAIL_SIGNOFF="Team EkStep"
# ── SIGNALS login page (the `signals` child theme) ────────────────────────────
# Each defaults to the network's own BRAND_* above, so a brand is correct with
# no addition to its keycloak.env. Previously these were env-only with hardcoded
# Blue Dots defaults that nothing set, so every non-blue network served the Blue
# Dots mark and palette on its signals login. Override per brand only where
# signals genuinely differs from the aggregator.
ARG SIGNALS_BRAND_SHORT_NAME=${BRAND_SHORT_NAME}
# "<short> Signals" — matches the old Blue Dots default, right for every network.
ARG SIGNALS_BRAND_LONG_NAME="${BRAND_SHORT_NAME} Signals"
ARG SIGNALS_BRAND_SSO_LABEL=${BRAND_SSO_LABEL}
ARG SIGNALS_BRAND_LOGO_SLUG=${BRAND_LOGO_SLUG}
ARG SIGNALS_BRAND_FONT_SANS=${BRAND_FONT_SANS}
ARG SIGNALS_BRAND_FONT_HEADING=${BRAND_FONT_HEADING}
ARG SIGNALS_BRAND_FONT_BODY=${BRAND_FONT_BODY}
ARG SIGNALS_BRAND_PRIMARY_COLOR=${BRAND_PRIMARY_COLOR}
ARG SIGNALS_BRAND_PRIMARY_DARK=${BRAND_PRIMARY_DARK}
ARG SIGNALS_BRAND_PRIMARY_500=${BRAND_PRIMARY_500}
ARG SIGNALS_BRAND_PRIMARY_100=${BRAND_PRIMARY_100}
ARG SIGNALS_BRAND_PRIMARY_50=${BRAND_PRIMARY_50}
# Signals-specific wording — NOT derived from the aggregator, because this is
# where the two pages are meant to read differently.
ARG SIGNALS_BRAND_APP_LABEL="Signals Network"
ARG SIGNALS_HERO_TITLE_LEAD="Welcome to"
ARG SIGNALS_HERO_TITLE_HIGHLIGHT="the Signals network"
ARG SIGNALS_HERO_TITLE_TAIL=""
ARG SIGNALS_HERO_SUBTITLE="Sign in to discover and connect across the network."

# Theme source — read from the repo's checked-in theme tree.
# --chown is required, not cosmetic: COPY lands files as uid 0, but this image's
# default user is 65532, so the RUN below (which rewrites theme.properties inside
# /custom) would fail with EACCES without it.
COPY --chown=65532:65532 infra/keycloak/themes /custom

# Overwrite theme.properties so brand vars are baked literals, not
# `${env.VAR:default}` placeholders. Removes the runtime env dependence
# the compose stack uses; the image hash now uniquely identifies the
# brand.
RUN { \
      printf 'parent=keycloak.v2\n'; \
      printf 'brandShortName=%s\n'      "${BRAND_SHORT_NAME}"; \
      printf 'brandLongName=%s\n'       "${BRAND_LONG_NAME}"; \
      printf 'brandSsoLabel=%s\n'       "${BRAND_SSO_LABEL}"; \
      printf 'brandAppLabel=%s\n'       "${BRAND_APP_LABEL}"; \
      printf 'brandLogoSlug=%s\n'       "${BRAND_LOGO_SLUG}"; \
      printf 'heroLogo=%s\n'            "${BRAND_HERO_LOGO}"; \
      printf 'brandSeededBy=%s\n'       "${BRAND_SEEDED_BY}"; \
      printf 'brandFontSans=%s\n'       "${BRAND_FONT_SANS}"; \
      printf 'brandFontHeading=%s\n'    "${BRAND_FONT_HEADING}"; \
      printf 'brandFontBody=%s\n'       "${BRAND_FONT_BODY}"; \
      printf 'heroTitleLead=%s\n'       "${HERO_TITLE_LEAD}"; \
      printf 'heroTitleHighlight=%s\n'  "${HERO_TITLE_HIGHLIGHT}"; \
      printf 'heroTitleTail=%s\n'       "${HERO_TITLE_TAIL}"; \
      printf 'heroSubtitle=%s\n'        "${HERO_SUBTITLE}"; \
      printf 'brandPrimary=%s\n'        "${BRAND_PRIMARY_COLOR}"; \
      printf 'brandPrimaryDark=%s\n'    "${BRAND_PRIMARY_DARK}"; \
      printf 'brandPrimary500=%s\n'     "${BRAND_PRIMARY_500}"; \
      printf 'brandPrimary100=%s\n'     "${BRAND_PRIMARY_100}"; \
      printf 'brandPrimary50=%s\n'      "${BRAND_PRIMARY_50}"; \
      printf 'brandHeroBg=%s\n'         "${BRAND_HERO_BG}"; \
      printf 'brandHeroGrad=%s\n'       "${BRAND_HERO_GRAD}"; \
    } > /custom/otp/login/theme.properties

# Same idea for the one per-network string in the EMAIL theme. Only this key is
# rewritten — the rest of the copy stays reviewable in the theme tree rather
# than being buried in a printf here. `|` as the sed delimiter so a sign-off
# containing `/` cannot break the expression.
RUN sed -i "s|^emailOtpSignoff=.*|emailOtpSignoff=${EMAIL_SIGNOFF}|" \
      /custom/otp/email/messages/messages_en.properties \
    && grep -qF -- "emailOtpSignoff=${EMAIL_SIGNOFF}" \
      /custom/otp/email/messages/messages_en.properties

# Bake the `signals` theme like `otp` above, so nothing depends on env at request
# time. `parent=otp` is re-emitted first: without it the theme stops inheriting
# and the keys it does not declare (brandSeededBy, brandHeroBg, brandHeroGrad)
# vanish from the page.
RUN { \
      printf 'parent=otp\n'; \
      printf 'brandShortName=%s\n'     "${SIGNALS_BRAND_SHORT_NAME}"; \
      printf 'brandLongName=%s\n'      "${SIGNALS_BRAND_LONG_NAME}"; \
      printf 'brandAppLabel=%s\n'      "${SIGNALS_BRAND_APP_LABEL}"; \
      printf 'brandSsoLabel=%s\n'      "${SIGNALS_BRAND_SSO_LABEL}"; \
      printf 'brandLogoSlug=%s\n'      "${SIGNALS_BRAND_LOGO_SLUG}"; \
      printf 'heroTitleLead=%s\n'      "${SIGNALS_HERO_TITLE_LEAD}"; \
      printf 'heroTitleHighlight=%s\n' "${SIGNALS_HERO_TITLE_HIGHLIGHT}"; \
      printf 'heroTitleTail=%s\n'      "${SIGNALS_HERO_TITLE_TAIL}"; \
      printf 'heroSubtitle=%s\n'       "${SIGNALS_HERO_SUBTITLE}"; \
      printf 'brandFontSans=%s\n'      "${SIGNALS_BRAND_FONT_SANS}"; \
      printf 'brandFontHeading=%s\n'   "${SIGNALS_BRAND_FONT_HEADING}"; \
      printf 'brandFontBody=%s\n'      "${SIGNALS_BRAND_FONT_BODY}"; \
      printf 'brandPrimary=%s\n'       "${SIGNALS_BRAND_PRIMARY_COLOR}"; \
      printf 'brandPrimaryDark=%s\n'   "${SIGNALS_BRAND_PRIMARY_DARK}"; \
      printf 'brandPrimary500=%s\n'    "${SIGNALS_BRAND_PRIMARY_500}"; \
      printf 'brandPrimary100=%s\n'    "${SIGNALS_BRAND_PRIMARY_100}"; \
      printf 'brandPrimary50=%s\n'     "${SIGNALS_BRAND_PRIMARY_50}"; \
    } > /custom/signals/login/theme.properties \
    && grep -qF -- "brandLogoSlug=${SIGNALS_BRAND_LOGO_SLUG}" \
      /custom/signals/login/theme.properties \
    && grep -qF -- 'parent=otp' /custom/signals/login/theme.properties

# Init-container entrypoint: copy the themes into the shared volume the main
# Keycloak container mounts at /opt/keycloak/themes, then exit. Using `cp -rT`
# — there are no symlinks in this tree (`find infra/keycloak/themes -type l`
# is empty), so `-a`'s symlink-preservation buys nothing here and was the sole
# reason `cp` emitted the ownership/permissions warnings below on every boot.
#
# Stages the WHOLE tree, not just `otp`: `signals` (which the signals-ui client
# selects via its `login_theme` attribute) sits alongside it, and copying only
# `otp` would leave that override pointing at a theme absent from disk. Both are
# listed so a missing one fails the init container loudly instead of silently
# falling back to the realm default.
#
# ONE THING THIS DEPENDS ON, now that the image runs as nonroot (uid 65532):
# the Keycloak pod's `fsGroup` MUST be set. The kubelet then group-owns the
# shared emptyDir and adds that group to this process, which is the only
# reason uid 65532 can write into it. Verified against the current
# `fsGroup: 0`: exits 0, stages 42 files. Without an fsGroup the volume is
# root-owned 0755 and this fails with `cp: can't create directory
# '/shared/otp': Permission denied` and exit 1 — i.e. Keycloak never starts.
CMD ["sh", "-c", "set -e; mkdir -p /shared; cp -rT /custom /shared && ls /shared/otp/login /shared/signals/login >/dev/null && echo 'themes staged at /shared: otp, signals'"]
