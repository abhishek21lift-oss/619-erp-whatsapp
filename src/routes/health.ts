// Liveness and readiness (architecture §14.3).
//
// ── The distinction is load-bearing, not ceremony ───────────────────────────
//
// /healthz answers "is this process alive" and touches NOTHING external. It is
// what Docker's HEALTHCHECK calls, and a liveness probe that fails on a Redis
// outage restart-loops a perfectly healthy process — turning a dependency blip
// into an outage of its own, and losing every live WhatsApp socket on each
// restart for good measure.
//
// /readyz answers "can this process do its job", and is allowed to say no.

import type { FastifyInstance } from 'fastify';
import { access, constants } from 'node:fs/promises';
import type { RedisHandle } from '../store/redis.js';
import type { InstanceRegistry } from '../domain/registry.js';

export const PUBLIC_PATHS = ['/healthz', '/readyz'] as const;

/** Only the part of the outbox /metrics needs — see store/qr.ts on fakeability. */
export interface OutboxDepthReader {
  depth(): Promise<{ pending: number; processing: number; dead: number }>;
}

export interface HealthDeps {
  redis: RedisHandle;
  registry: InstanceRegistry;
  outbox: OutboxDepthReader;
  sessionDir: string;
  version: string;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/healthz', async () => ({
    status: 'ok',
    service: '619-erp-whatsapp',
    version: deps.version,
    uptime_s: Math.round(process.uptime()),
  }));

  app.get('/readyz', async (_request, reply) => {
    const checks: Record<string, boolean> = {};

    checks['redis'] = await deps.redis.ping();

    // W_OK rather than F_OK: a session directory that exists but is not
    // writable is exactly the failure this check exists to catch — a volume
    // mounted read-only, or owned by the wrong uid after an image change. The
    // symptom otherwise appears much later, as a failed `saveCreds`, which is
    // the worst possible moment to discover it.
    try {
      await access(deps.sessionDir, constants.W_OK);
      checks['session_dir_writable'] = true;
    } catch {
      checks['session_dir_writable'] = false;
    }

    // Reaching into the registry proves the manifest loaded — it throws if
    // load() was never awaited.
    try {
      deps.registry.summary();
      checks['manifest_loaded'] = true;
    } catch {
      checks['manifest_loaded'] = false;
    }

    const ready = Object.values(checks).every(Boolean);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });

  // Authenticated, because per-tenant instance counts are tenant data
  // (architecture §14.3). Not on PUBLIC_PATHS.
  app.get('/metrics', async () => {
    const summary = deps.registry.summary();
    const depth = await deps.outbox.depth();
    return {
      instances_total: summary.total,
      instances_live: summary.live,
      instances_capacity: summary.capacity,
      outbox_pending: depth.pending,
      outbox_processing: depth.processing,
      outbox_dead: depth.dead,
    };
  });
}
