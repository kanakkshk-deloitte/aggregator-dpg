/**
 * Process entrypoint of the aggregator API (`@aggregator-dpg/api`). Builds the
 * Fastify app and starts listening.
 */

import './env.js';
import { buildApp } from './app.js';
import { adminEmails, config, defaultOrgOwnerEmail } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/client.js';
import { closeRateLimiter } from './services/rate-limiter/index.js';
import { closeRedis } from './services/redis/index.js';
import { closeBulkQueue } from './services/bulk-queue/index.js';
import { closeCampaignProcessQueue } from './services/campaign-process-queue/index.js';
import { getNetworkConfig } from './services/network-config.js';
import {
  ensureRootOrganisation,
  mirrorRootOrganisations,
  rootConfigFrom,
  type RootState,
} from './services/organisation-root.js';
import { getIdpAdmin } from './services/idp-admin/index.js';
import { getOrganisationStore } from './services/organisation-store/index.js';
import { warnOrgTreeOverLimits } from './services/org-tree-warnings.js';
import { setApprovalBrand } from './views/approval-pages.js';
import { initRbac, stopRbacRefresh } from './services/authz/index.js';
import { startTokenRolesRepair, stopTokenRolesRepair } from './services/authz/token-roles-sweep.js';
import { setEmailBrand } from './services/email-templates/shared.js';
import {
  loadEmailMessageOverrides,
  assertMessagesComplete,
} from './services/email-templates/messages.js';

async function main(): Promise<void> {
  if (config.RUN_MIGRATIONS_ON_BOOT) {
    try {
      await runMigrations();
    } catch (err) {
      logger.error({ err }, 'failed to run migrations on boot');
      process.exit(1);
    }
  }

  const app = await buildApp();

  // Load the RBAC role snapshot once. No-op with RBAC_MODE=off; otherwise an
  // invalid catalogue stops boot.
  try {
    await initRbac();
  } catch (err) {
    logger.error({ err }, 'failed to initialise rbac');
    process.exit(1);
  }

  // Give the approval HTML pages the deployment's brand (logo, palette).
  try {
    const cfg = await getNetworkConfig();
    setApprovalBrand({
      short_name: cfg.aggregator.brand.short_name,
      long_name: cfg.aggregator.brand.long_name,
      primary_color: cfg.aggregator.brand.primary_color ?? '#4f46e5',
      portal_url: process.env.PUBLIC_PORTAL_URL ?? 'http://localhost:3000',
    });
    setEmailBrand({
      short_name: cfg.aggregator.brand.short_name,
      long_name: cfg.aggregator.brand.long_name,
      primary_color: cfg.aggregator.brand.primary_color ?? '#4f46e5',
    });
  } catch (err) {
    logger.warn({ err }, 'approval brand seed failed — falling back to default');
  }

  // Replace the seeded placeholders for the network root and Default org with
  // configured values. Runs on every boot and never throws; a failure is logged
  // and retried next boot. The IdP mirror runs after `listen`.
  let rootState: RootState | null = null;
  {
    let network: { urlSlug?: string; name?: string; legalName?: string | null } | null = null;
    try {
      const cfg = await getNetworkConfig();
      network = {
        urlSlug: cfg.aggregator.brand.url_slug,
        name: cfg.aggregator.name,
        legalName: cfg.aggregator.legal_name ?? null,
      };
    } catch {
      network = null; // logged above by the brand seed
    }
    rootState = await ensureRootOrganisation(
      rootConfigFrom(network, adminEmails, defaultOrgOwnerEmail()),
    );
  }

  // Warn about orgs outside the tree limits or "known as" config. Logs only.
  try {
    const cfg = await getNetworkConfig();
    await warnOrgTreeOverLimits(getOrganisationStore(), cfg.aggregator.organisation, logger);
  } catch (err) {
    logger.error({
      operation: 'orgTree.bootCheck',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.name : typeof err,
    });
  }

  // RBAC edge: keep every user's token `roles` claim in step with the
  // database. After the owner reconcile above, so the first full reconcile
  // already sees a new root or Default owner. A no-op with RBAC_MODE=off.
  startTokenRolesRepair();

  // Merge email copy overrides (network, brand, instance) over the bundled
  // defaults. A missing or unreadable override is skipped; a key missing from
  // the defaults stops boot.
  const overridden = await loadEmailMessageOverrides();
  assertMessagesComplete();
  logger.info({
    operation: 'emailMessages.init',
    status: 'success',
    overridden_keys: overridden,
  });

  const shutdown = (signal: string) => async () => {
    logger.info({ signal }, 'shutting down');
    try {
      // Drain HTTP first, then close every backing connection.
      await app.close();
      stopRbacRefresh();
      stopTokenRolesRepair();
      await closeDb();
      await Promise.allSettled([
        closeRateLimiter(),
        closeRedis(),
        closeBulkQueue(),
        closeCampaignProcessQueue(),
      ]);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    logger.info({ host: config.HOST, port: config.PORT }, 'api listening');
    // Fire-and-forget: mirrorRootOrganisations never throws.
    if (rootState) void mirrorRootOrganisations(rootState, getIdpAdmin());
  } catch (err) {
    logger.error({ err }, 'failed to start api');
    process.exit(1);
  }
}

void main();
