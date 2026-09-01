// The Fastify application factory.
//
// Separate from server.ts so tests can build an app with fake dependencies and
// drive it through `app.inject()` — no listening socket, no Redis, no Baileys.
// Every tenant-isolation test in this repo depends on that separation, which is
// the reason it exists rather than a stylistic preference.

import Fastify, { LogController, type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { GatewayError, toErrorBody, ErrorCode } from './errors.js';
import { getLogger } from './logger.js';
import { registerGatewayAuth, REQUEST_ID_HEADER, ORG_HEADER } from './plugins/gatewayAuth.js';
import { registerHealthRoutes, PUBLIC_PATHS, type HealthDeps } from './routes/health.js';
import { registerInstanceRoutes } from './routes/instances.js';
import type { InstanceRegistry } from './domain/registry.js';

export interface AppDeps extends HealthDeps {
  config: Config;
  registry: InstanceRegistry;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;

  const app = Fastify({
    // Widened to FastifyBaseLogger deliberately. Handing Fastify the concrete
    // pino `Logger` type binds its generics to it, and every helper below that
    // takes a plain `FastifyInstance` then fails to match — pino's BaseLogger
    // requires `msgPrefix`, which FastifyBaseLogger does not have. The runtime
    // value is identical either way; this only stops the generic from
    // narrowing.
    loggerInstance: getLogger() as FastifyBaseLogger,
    // The backend passes its own request id so one operation can be followed
    // across both services' logs. Generating a fresh one here would break that
    // trail at exactly the hop where it matters most.
    genReqId: (req) => {
      const supplied = req.headers[REQUEST_ID_HEADER];
      return typeof supplied === 'string' && supplied.length > 0 && supplied.length <= 128
        ? supplied
        : randomUUID();
    },
    // 64 KB. No media crosses this hop in the MVP, and the small limit means
    // shipping media later has to be a deliberate change rather than something
    // that quietly starts working. Architecture §7.5.
    bodyLimit: 64 * 1024,
    trustProxy: false,
    // Fastify's own request/response pair is turned off and replaced by the
    // single onResponse line below, which carries the tenant and instance —
    // the two fields an incident is actually about, and neither of which
    // Fastify's default lines include.
    //
    // Via logController rather than the top-level `disableRequestLogging`
    // flag: that flag is deprecated in Fastify 5 and removed in 6, and it
    // warns on every app construction — which in a test suite that builds an
    // app per case buries the output that matters.
    logController: new LogController({ disableRequestLogging: true }),
  });

  await app.register(helmet, {
    // No browser ever loads a page from this service; a CSP would be
    // decoration. The transport and sniffing headers still earn their place.
    contentSecurityPolicy: false,
  });

  // NOTE: no CORS plugin, deliberately. Not a restrictive policy — an absent
  // one. No browser may call this service (architecture §7.5), and registering
  // @fastify/cors with a strict origin list would imply that some browser
  // origin is expected to.

  await app.register(rateLimit, {
    max: config.WA_RATE_LIMIT_MAX,
    timeWindow: config.WA_RATE_LIMIT_WINDOW_MS,
    // Keyed by the acting organization rather than the source IP: every request
    // arrives from the single backend container, so an IP key would put the
    // whole platform in one bucket and let one studio's runaway poll loop
    // rate-limit everybody else.
    keyGenerator: (request) => {
      const org = request.headers[ORG_HEADER];
      return typeof org === 'string' && org.length > 0 ? org : request.ip;
    },
    errorResponseBuilder: () => ({
      error: { code: ErrorCode.RATE_LIMITED, message: 'Too many requests.' },
    }),
  });

  registerGatewayAuth(app, {
    expectedKey: config.WA_GATEWAY_KEY,
    publicPaths: PUBLIC_PATHS,
  });

  // One structured line per request (architecture §14.1). Fastify's built-in
  // pair of lines is disabled above because it logs neither the tenant nor the
  // instance, which are the two fields an incident is actually about.
  app.addHook('onResponse', async (request, reply) => {
    const org = request.headers[ORG_HEADER];
    request.log.info(
      {
        request_id: request.id,
        tenant_id: typeof org === 'string' ? org : undefined,
        operation: `${request.method} ${request.routeOptions.url ?? request.url}`,
        status: reply.statusCode < 400 ? 'ok' : 'error',
        status_code: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime),
      },
      'request_completed',
    );
  });

  registerHealthRoutes(app, deps);
  registerInstanceRoutes(app, { registry: deps.registry });

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: { code: ErrorCode.INSTANCE_NOT_FOUND, message: 'Not found.' } }),
  );

  /**
   * The single place an error becomes a response.
   *
   * A GatewayError is intentional and its message is safe to return. Anything
   * else is a bug, and its message is not: it can carry a file path, a
   * connection string, or an upstream error body. Those are logged in full and
   * answered with a bare 500 — architecture §7.5.
   */
  app.setErrorHandler(async (raw: unknown, request, reply) => {
    // `unknown`, not Fastify's FastifyError: anything can be thrown, and a
    // route that throws a plain string or a rejected non-Error would otherwise
    // hit `.statusCode` on a primitive and turn one bad request into a crash
    // inside the handler meant to contain it.
    const error = raw as { statusCode?: unknown; message?: string; stack?: string };

    if (raw instanceof GatewayError) {
      request.log.warn(
        {
          request_id: request.id,
          code: raw.code,
          status: 'error',
          ...raw.context,
        },
        'request_failed',
      );
      return reply.code(raw.statusCode).send(toErrorBody(raw));
    }

    // Fastify's own body-parse and payload-too-large errors arrive here with a
    // 4xx statusCode already set. Reporting those as 500 would tell the backend
    // to retry a request that will never succeed.
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 400 && status < 500) {
      request.log.warn(
        { request_id: request.id, status: 'error', err: error.message },
        'request_rejected',
      );
      return reply
        .code(status)
        .send({ error: { code: ErrorCode.VALIDATION_ERROR, message: 'Invalid request.' } });
    }

    request.log.error(
      { request_id: request.id, status: 'error', err: error.message, stack: error.stack },
      'request_errored',
    );
    return reply
      .code(500)
      .send({ error: { code: ErrorCode.INTERNAL, message: 'Internal error.' } });
  });

  return app;
}
