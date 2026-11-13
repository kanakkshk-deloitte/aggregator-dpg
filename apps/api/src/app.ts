/**
 * Builds the api app's Fastify instance. Separate from `server.ts` so tests
 * can run the app without binding a port.
 *
 * Wires:
 *   - request id generation + propagation via `x-request-id`
 *   - per-request structured logging (entry + exit + latency)
 *   - global error handler that renders the canonical error envelope
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import sensible from '@fastify/sensible';
import fastifySwagger from '@fastify/swagger';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import {
  config,
  corsOrigins,
  apiReferenceEnabled,
  signalsUiUrlWarnings,
  onboardingEnabledWarnings,
} from './config.js';
import { loggerOptions } from './logger.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAggregatorRegistrationRoutes } from './routes/aggregator-registrations.js';
import { registerAggregatorMaintenanceRoutes } from './routes/aggregator-maintenance.js';
import { registerAggregatorOrgRoutes } from './routes/aggregator-orgs.js';
import { registerAggregatorOrgApprovalRoutes } from './routes/aggregator-org-approvals.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerAggregatorApprovalRoutes } from './routes/aggregator-approvals.js';
import { registerAggregatorProfileRoutes } from './routes/aggregator-profile.js';
import { registerV1UserRoutes } from './routes/v1-user.js';
import { registerV1OrgRoutes } from './routes/v1-org.js';
import { registerV1IamRoutes } from './routes/v1-iam.js';
import { registerV1RbacCatalogueRoutes } from './routes/v1-rbac-catalogue.js';
import { registerBulkUploadsRoutes } from './routes/bulk-uploads.js';
import { registerRegistrationLinksRoutes } from './routes/registration-links.js';
import { registerPublicRegistrationLinkRoutes } from './routes/public-registration-links.js';
import { registerPublicLookupRoute } from './routes/public-lookup.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerAggregatorConfigRoutes } from './routes/aggregator-config.js';
import { registerSupportRoutes } from './routes/support.js';
import { registerCampaignExportRoutes } from './routes/campaign-export.js';
import { registerCampaignVoiceRoutes } from './routes/campaign-voice.js';
import { registerCampaignEmailRoutes } from './routes/campaign-email.js';
import { registerCampaignJobRoutes } from './routes/campaign-jobs.js';
import { ERR } from './errors/codes.js';
import { HttpError } from './errors/http-error.js';
import { coerceToHttpError, toEnvelope, toLogPayload } from './errors/serialize.js';
import { assertRouteDeclared } from './services/authz/index.js';

const REQUEST_ID_HEADER = 'x-request-id';
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Shared options, so `req.log` uses the same PII/secret redaction as the rest of the API.
    logger: loggerOptions,
    // Trust only the proxies in `TRUST_PROXY`. Trusting all would let callers forge
    // `X-Forwarded-For` and bypass the rate limiter keyed on `req.ip`.
    // The default trusts RFC1918 only; production must set the BFF subnet.
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    requestIdHeader: REQUEST_ID_HEADER,
    requestIdLogLabel: 'reqId',
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      if (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128) {
        return incoming;
      }
      return `req-${randomUUID()}`;
    },
    disableRequestLogging: true,
  });

  // `SIGNALS_UI_URLS` is parsed before a logger exists, so log its skipped entries here.
  for (const warning of signalsUiUrlWarnings) {
    app.log.warn({ operation: 'config.parseSignalsUiUrls', status: 'skipped' }, warning);
  }

  // Same for `AGGREGATOR_ONBOARDING_ENABLED`. The check against declared
  // registration modes lives in `services/network-config.ts`.
  for (const warning of onboardingEnabledWarnings) {
    app.log.warn({ operation: 'config.parseOnboardingEnabled', status: 'skipped' }, warning);
  }

  await app.register(cors, {
    origin: corsOrigins.length === 0 || corsOrigins.includes('*') ? true : corsOrigins,
    credentials: false,
  });
  await app.register(formbody);
  await app.register(sensible);

  // Routes declare zod schemas; Fastify validates with them and swagger turns them into OpenAPI.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // The docs are off in production unless API_REFERENCE_FORCE is set, since the spec lists admin routes.
  // Validation does not depend on this.
  if (apiReferenceEnabled) {
    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: 'Aggregator DPG API',
          description:
            'Aggregator BFF for the Blue Dots / Purple Dots networks — handles aggregator registration, brand + network config, public participant onboarding (link + bulk), and the dashboard rollup proxy to signalstack.',
          version: pkg.version,
        },
        // The deployment's public URL plus a local-dev entry, unless they are the same.
        servers: [
          {
            url: config.PUBLIC_API_URL,
            description: "Your deployment's public host (set per instance)",
          },
          ...(config.PUBLIC_API_URL === 'http://localhost:4000'
            ? []
            : [{ url: 'http://localhost:4000', description: 'Local development' }]),
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
              description:
                'Keycloak-issued access token (aggregator-portal / aggregator-api client).',
            },
          },
        },
        tags: [
          { name: 'health', description: 'Liveness + readiness probes.' },
          {
            name: 'aggregator-config',
            description: 'Public brand + network config served to the web BFF.',
          },
          {
            name: 'aggregator-registrations',
            description: 'Self-serve aggregator onboarding (org create + approval).',
          },
          {
            name: 'aggregator-approvals',
            description: 'Admin approve/reject for pending aggregators.',
          },
          {
            name: 'aggregator-profile',
            description: 'Authenticated aggregator profile read/update.',
          },
          {
            name: 'registration-links',
            description: 'QR / shareable registration links (authenticated owner side).',
          },
          {
            name: 'public-registration',
            description: 'Public participant registration via QR link.',
          },
          { name: 'bulk-uploads', description: 'CSV bulk participant onboarding.' },
          { name: 'onboarding', description: 'Single-participant onboarding (authenticated).' },
          { name: 'dashboard', description: 'Dashboard rollup + items proxy to signalstack.' },
          { name: 'support', description: 'Authenticated contact-support form submission.' },
          {
            name: 'console',
            description:
              'Organisation console (/v1/user, /v1/org): org owners and the network admin manage coordinators and organisation details.',
          },
          {
            name: 'campaign',
            description: 'Campaign integrations — participant PII export (#579).',
          },
        ],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(import('@scalar/fastify-api-reference'), {
      routePrefix: '/api/reference',
    });
  }

  // Every route must declare `config.rbac`; a route without one stops the app from booting.
  app.addHook('onRoute', assertRouteDeclared);

  app.addHook('onRequest', async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
    req.log.info(
      { event: 'request.start', method: req.method, url: req.url },
      `→ ${req.method} ${req.url}`,
    );
  });

  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      {
        event: 'request.end',
        method: req.method,
        url: req.url,
        statusCode: reply.statusCode,
        latency_ms: Math.round(reply.elapsedTime),
      },
      `← ${req.method} ${req.url} ${reply.statusCode}`,
    );
  });

  await registerHealthRoutes(app);
  await registerAggregatorRegistrationRoutes(app);
  await registerAggregatorMaintenanceRoutes(app);
  registerAggregatorOrgRoutes(app);
  await registerAggregatorOrgApprovalRoutes(app);
  await registerInviteRoutes(app);
  await registerAggregatorApprovalRoutes(app);
  registerAggregatorProfileRoutes(app);
  registerV1UserRoutes(app);
  registerV1OrgRoutes(app);
  registerV1IamRoutes(app);
  registerV1RbacCatalogueRoutes(app);
  await registerBulkUploadsRoutes(app);
  await registerRegistrationLinksRoutes(app);
  await registerPublicRegistrationLinkRoutes(app);
  await registerPublicLookupRoute(app);
  await registerOnboardingRoutes(app);
  await registerDashboardRoutes(app);
  await registerAggregatorConfigRoutes(app);
  await registerSupportRoutes(app);
  await registerCampaignExportRoutes(app);
  await registerCampaignJobRoutes(app, 'export');
  await registerCampaignVoiceRoutes(app);
  await registerCampaignJobRoutes(app, 'voice');
  await registerCampaignEmailRoutes(app);
  await registerCampaignJobRoutes(app, 'email');

  app.setErrorHandler((rawErr, req, reply) => {
    // Turn Fastify validation errors into the standard error envelope.
    const fastifyValidation = (rawErr as { validation?: unknown[] }).validation;
    let err: HttpError;
    if (Array.isArray(fastifyValidation) && fastifyValidation.length > 0) {
      err = new HttpError(ERR.SCHEMA_VALIDATION, {
        cause: rawErr,
        fields: { issues: fastifyValidation },
      });
    } else if ((rawErr as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      // This Fastify error has no `statusCode`, so map it to 413 here instead of a 500.
      err = new HttpError(ERR.PAYLOAD_TOO_LARGE, { cause: rawErr });
    } else {
      err = coerceToHttpError(rawErr);
    }

    const includeStack = config.NODE_ENV !== 'production';
    const logPayload = toLogPayload(err, includeStack);

    if (err.status >= 500) {
      req.log.error(logPayload, err.title);
    } else {
      req.log.warn(logPayload, err.title);
    }

    return reply.status(err.status).send(toEnvelope(err, req.id));
  });

  app.setNotFoundHandler((req, reply) => {
    const err = new HttpError(ERR.NOT_FOUND, {
      detail: `No route for ${req.method} ${req.url}`,
    });
    req.log.warn(toLogPayload(err, false), err.title);
    return reply.status(err.status).send(toEnvelope(err, req.id));
  });

  return app;
}

/**
 * Parses `TRUST_PROXY` into the shape Fastify expects.
 *
 *   "loopback,linklocal,uniquelocal" → "loopback, linklocal, uniquelocal"
 *   "10.0.0.0/8,127.0.0.1"          → "10.0.0.0/8, 127.0.0.1"
 *   "true" / "false"                 → boolean (compat with legacy configs)
 *
 * @param raw - Comma-separated value from {@link config.TRUST_PROXY}.
 * @returns A value accepted by Fastify's `trustProxy` option.
 */
function parseTrustProxy(raw: string): string | boolean {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}
