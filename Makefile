.PHONY: help setup dev up down logs ps reset psql redis-cli mc kc rebuild-web rebuild-keycloak kc-plugin kc-logs \
        helm-sync-files helm-deps helm-lint helm-template helm-package helm-install-dev helm-uninstall \
        check-brand

# ─── Helm chart settings ────────────────────────────────────────────────
HELM_CHART_DIR    ?= helm/aggregator-dpg
HELM_RELEASE_NAME ?= aggregator
HELM_NAMESPACE    ?= aggregator

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

setup: ## One-shot: bootstrap .env + add keycloak/minio host entries (delegates to scripts/stack.mjs).
	pnpm stack:setup

dev: up ## Alias for `up`. Brings the full local stack up.

up: check-brand ## Start all foundations + apps in the background.
	pnpm stack:up

check-brand: ## Verify AGGREGATOR_BRAND folder exists when the var is set.
	@net="$${AGGREGATOR_NETWORK:-$$(grep -E '^AGGREGATOR_NETWORK=' .env 2>/dev/null | tail -1 | cut -d= -f2-)}"; \
	net="$${net:-blue_dot}"; \
	brand="$${AGGREGATOR_BRAND:-$$(grep -E '^AGGREGATOR_BRAND=' .env 2>/dev/null | tail -1 | cut -d= -f2-)}"; \
	if [ -n "$$brand" ]; then \
	  dir="config/$$net/$$brand"; \
	  if [ ! -d "$$dir" ]; then \
	    echo "ERROR: AGGREGATOR_BRAND=$$brand set but $$dir not found." >&2; \
	    echo "       Create the brand folder or unset AGGREGATOR_BRAND for the standard $$net." >&2; \
	    exit 1; \
	  fi; \
	  echo "brand ok: $$dir"; \
	else \
	  echo "no brand set — using standard config/$$net"; \
	fi

down: ## Stop and remove all containers (data volumes preserved).
	pnpm stack:down

reset: ## Stop everything and wipe data volumes. Destructive.
	pnpm stack:reset

logs: ## Tail logs for all services.
	pnpm stack:logs

ps: ## Show service status.
	pnpm stack:ps

psql: ## Open psql against the local Postgres.
	pnpm stack:psql

redis-cli: ## Open redis-cli against the local Redis.
	docker compose exec redis redis-cli

mc: ## Open a one-shot MinIO mc shell against the local server.
	docker run --rm -it --network aggregator-dpg_default \
		-e MC_HOST_local=http://$${MINIO_ROOT_USER:-minioadmin}:$${MINIO_ROOT_PASSWORD:-minioadmin}@minio:9000 \
		minio/mc sh

kc: ## Print Keycloak admin URL.
	@echo "http://localhost:8080  (admin / \$${KC_BOOTSTRAP_ADMIN_PASSWORD:-admin})"

rebuild-web: ## Rebuild the web image and restart only the web container.
	pnpm stack:rebuild-web

KC_PLUGIN_REPO ?= ../keycloak-otp-authenticator
KC_PLUGIN_JAR  := keycloak-otp-1.0.0-SNAPSHOT.jar

kc-plugin: ## Build the Keycloak OTP plugin JAR and copy into infra/keycloak/providers.
	cd $(KC_PLUGIN_REPO) && ./mvnw -q clean package -DskipTests
	cp $(KC_PLUGIN_REPO)/dist/target/$(KC_PLUGIN_JAR) infra/keycloak/providers/
	@echo "Copied $(KC_PLUGIN_JAR) → infra/keycloak/providers/"

rebuild-keycloak: kc-plugin ## Rebuild the OTP plugin and restart Keycloak (re-imports realm on first boot only).
	docker compose restart keycloak
	@echo "Tail with: make kc-logs"

kc-logs: ## Tail Keycloak logs.
	docker compose logs -f keycloak

# ─── Helm chart targets ─────────────────────────────────────────────────

helm-sync-files: ## Copy infra/ source-of-truth files into the chart's files/ dirs.
	@mkdir -p $(HELM_CHART_DIR)/charts/keycloak/files $(HELM_CHART_DIR)/files
	@cp infra/keycloak/realms/aggregator-realm.json   $(HELM_CHART_DIR)/charts/keycloak/files/aggregator-realm.json
	@cp infra/keycloak/render-realm.sh                $(HELM_CHART_DIR)/charts/keycloak/files/render-realm.sh
	@cp infra/keycloak/init/apply-user-profile.sh     $(HELM_CHART_DIR)/files/apply-user-profile.sh
	@echo "Synced realm JSON, render-realm.sh, apply-user-profile.sh into $(HELM_CHART_DIR)/."

helm-deps: helm-sync-files ## Run `helm dependency update` to fetch Bitnami subcharts.
	helm dependency update $(HELM_CHART_DIR)

helm-lint: helm-sync-files ## Lint the chart with values-dev.yaml overlay.
	helm lint $(HELM_CHART_DIR) -f $(HELM_CHART_DIR)/values-dev.yaml

helm-template: helm-sync-files ## Render the chart to stdout (no install).
	helm template $(HELM_RELEASE_NAME) $(HELM_CHART_DIR) \
	  -f $(HELM_CHART_DIR)/values-dev.yaml \
	  --namespace $(HELM_NAMESPACE)

helm-package: helm-deps ## Package the chart into helm/aggregator-dpg-<ver>.tgz.
	helm package $(HELM_CHART_DIR) -d helm/

helm-install-dev: helm-deps ## Install the chart into the current kube-context with values-dev.yaml.
	helm upgrade --install $(HELM_RELEASE_NAME) $(HELM_CHART_DIR) \
	  -f $(HELM_CHART_DIR)/values-dev.yaml \
	  --namespace $(HELM_NAMESPACE) --create-namespace

helm-uninstall: ## Remove the release (does NOT delete PVCs).
	helm uninstall $(HELM_RELEASE_NAME) --namespace $(HELM_NAMESPACE)

# NOTE: the `keycloak-image` target is gone. The deployment Keycloak image (OTP
# SPI baked in + `kc.sh build`) is now built in the bluedots-automation repo at
# `dockerfiles/keycloak/`, published as ghcr.io/<owner>/keycloak-server by its
# manual "Build Keycloak image" workflow. Keycloak is a shared common service for
# both DPGs, so its image is released from the repo that deploys it.
#
# Local dev is unaffected: `make up` still runs the stock Keycloak image with
# infra/keycloak/providers bind-mounted and `start-dev`, which re-indexes the SPI
# on every boot. `make kc-plugin` / `make rebuild-keycloak` still work.
