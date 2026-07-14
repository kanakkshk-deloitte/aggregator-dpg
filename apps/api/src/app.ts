/**
 * Builds the Fastify app instance. Kept separate from `server.ts` so tests
 * can spin up an in-memory app without binding to a network port.
 *
 * Wires:
 *   - request id generation + propagation via `x-request-id`
 *   - per-request structured logging (entry + exit + latency)
 *   - global error handler that renders the canonical error envelope
 */

import { randomUUID } from 'node:crypto';
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
import { config, corsOrigins, apiReferenceEnabled } from './config.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAggregatorRegistrationRoutes } from './routes/aggregator-registrations.js';
import { registerAggregatorMaintenanceRoutes } from './routes/aggregator-maintenance.js';
import { registerAggregatorOrgRoutes } from './routes/aggregator-orgs.js';
import { registerAggregatorOrgApprovalRoutes } from './routes/aggregator-org-approvals.js';
import { registerAggregatorApprovalRoutes } from './routes/aggregator-approvals.js';
import { registerAggregatorProfileRoutes } from './routes/aggregator-profile.js';
import { registerBulkUploadsRoutes } from './routes/bulk-uploads.js';
import { registerRegistrationLinksRoutes } from './routes/registration-links.js';
import { registerPublicRegistrationLinkRoutes } from './routes/public-registration-links.js';
import { registerPublicLookupRoute } from './routes/public-lookup.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerAggregatorConfigRoutes } from './routes/aggregator-config.js';
import { registerSupportRoutes } from './routes/support.js';
import { ERR } from './errors/codes.js';
import { HttpError } from './errors/http-error.js';
import { coerceToHttpError, toEnvelope, toLogPayload } from './errors/serialize.js';

const REQUEST_ID_HEADER = 'x-request-id';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      base: { service: 'aggregator-api', env: config.NODE_ENV },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          '*.password',
          '*.token',
          '*.access_token',
          '*.refresh_token',
        ],
        censor: '[REDACTED]',
      },
      ...(config.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:HH:MM:ss.l',
                singleLine: false,
                ignore: 'pid,hostname,service,env',
              },
            },
          }
        : {}),
    },
    // Trust only the upstream proxies named in `TRUST_PROXY`. Blanket
    // `true` would let any caller forge `X-Forwarded-For` and bypass the
    // public rate limiter, which is keyed off `req.ip`. The default trusts
    // RFC1918 only — production must point this at the BFF subnet.
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

  await app.register(cors, {
    origin: corsOrigins.length === 0 || corsOrigins.includes('*') ? true : corsOrigins,
    credentials: false,
  });
  await app.register(formbody);
  await app.register(sensible);

  // Zod-based schema compilers — routes declare request/response shapes
  // as zod schemas, fastify validates with them, and @fastify/swagger
  // converts them to OpenAPI for the Scalar UI at /api/reference.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Docs surface is env-gated and secure-by-default: the API is
  // internet-reachable, so the spec (which enumerates admin route paths) is
  // force-disabled under NODE_ENV=production (unless API_REFERENCE_FORCE).
  // Both the 3.5MB Scalar bundle and the swagger plugin register only when
  // enabled. Route-level zod validation/serialization is unaffected — the
  // compilers above run regardless.
  if (apiReferenceEnabled) {
    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: 'Aggregator DPG API',
          description:
            'Aggregator BFF for the Blue Dots / Purple Dots networks — handles aggregator registration, brand + network config, public participant onboarding (link + bulk), and the dashboard rollup proxy to signalstack.',
          version: '1.0.0',
        },
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
        ],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(import('@scalar/fastify-api-reference'), {
      routePrefix: '/api/reference',
    });
  }

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
  await registerAggregatorOrgRoutes(app);
  await registerAggregatorOrgApprovalRoutes(app);
  await registerAggregatorApprovalRoutes(app);
  await registerAggregatorProfileRoutes(app);
  await registerBulkUploadsRoutes(app);
  await registerRegistrationLinksRoutes(app);
  await registerPublicRegistrationLinkRoutes(app);
  await registerPublicLookupRoute(app);
  await registerOnboardingRoutes(app);
  await registerDashboardRoutes(app);
  await registerAggregatorConfigRoutes(app);
  await registerSupportRoutes(app);

  app.setErrorHandler((rawErr, req, reply) => {
    // Fastify schema validation error — promote to a typed HttpError so the
    // envelope shape matches the rest of the API.
    const fastifyValidation = (rawErr as { validation?: unknown[] }).validation;
    let err: HttpError;
    if (Array.isArray(fastifyValidation) && fastifyValidation.length > 0) {
      err = new HttpError(ERR.SCHEMA_VALIDATION, {
        cause: rawErr,
        fields: { issues: fastifyValidation },
      });
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
 * Parse `TRUST_PROXY` env into the shape Fastify expects.
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
