// Process entrypoint: wire the dependencies, listen, and shut down cleanly.

import { createRequire } from 'node:module';
import { loadConfig, setConfigForTesting } from './config.js';
import { getLogger } from './logger.js';
import { buildApp } from './app.js';
import { createRedis } from './store/redis.js';
import { QrStore } from './store/qr.js';
import { Manifest } from './store/manifest.js';
import { Outbox } from './events/outbox.js';
import { InstanceRegistry } from './domain/registry.js';
import { NullConnector } from './domain/nullConnector.js';
import { BaileysConnector } from './domain/baileysConnector.js';
import type { WhatsAppConnector } from './domain/instance.js';
import { ensureDir } from './store/paths.js';
import { sweepQuarantine } from './store/sessionRecovery.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

/** How long the outbox sweeper waits between passes. See Outbox.reclaimStale. */
const RECLAIM_INTERVAL_MS = 30_000;

/**
 * How often quarantined sessions are re-checked against the retention window.
 *
 * Daily. The window is measured in days, so anything more frequent is wasted
 * filesystem walking, and anything less would let a long-lived process hold
 * expired credential directories well past their retention.
 */
const QUARANTINE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Shutdown budget.
 *
 * Under the 30s `stop_grace_period` in the compose file, so the work below
 * completes before Docker escalates to SIGKILL. The part that matters is
 * closing WhatsApp sockets cleanly: a dropped TCP connection without a proper
 * close is one of the traffic patterns that looks like abuse to WhatsApp, and
 * these seconds are cheap insurance against that. Architecture §15.2.
 */
const SHUTDOWN_TIMEOUT_MS = 25_000;

async function main(): Promise<void> {
  // Parsed FIRST, before anything else is constructed. A missing
  // WA_GATEWAY_KEY must stop the process here rather than after a socket is
  // listening — see config.ts.
  const config = loadConfig();
  setConfigForTesting(config);

  const log = getLogger();
  log.info(
    { version, node_env: config.NODE_ENV, port: config.PORT },
    'gateway_starting',
  );

  await ensureDir(config.WA_SESSION_DIR);

  const redis = createRedis(config.REDIS_URL);
  await redis.client.connect();

  const manifest = new Manifest(config.WA_MANIFEST_PATH);
  await manifest.load();

  const outbox = new Outbox(redis.client);
  const qr = new QrStore(redis.client, config.WA_QR_TTL_SEC);

  // The manifest is the single source of instance ownership, so the connector
  // asks it rather than keeping a second copy that could drift from the
  // registry's. It is passed as a function, not the manifest itself, so the
  // connector cannot mutate it.
  const connector: WhatsAppConnector =
    config.WA_CONNECTOR === 'baileys'
      ? new BaileysConnector({
          sessionRoot: config.WA_SESSION_DIR,
          qr,
          outbox,
          resolveTenant: (instanceId) => manifest.get(instanceId)?.organization_id,
          quarantineRoot: config.WA_QUARANTINE_DIR,
          qrTtlSec: config.WA_QR_TTL_SEC,
          qrMaxRounds: config.WA_QR_MAX_ROUNDS,
          connectTimeoutMs: config.WA_CONNECT_TIMEOUT_MS,
        })
      : new NullConnector();
  log.info({ connector: config.WA_CONNECTOR }, 'connector_selected');

  const registry = new InstanceRegistry({
    manifest,
    connector,
    qr,
    outbox,
    maxInstances: config.WA_MAX_INSTANCES,
  });

  // Sweep BEFORE restoring. A restore can quarantine a fresh directory, and
  // sweeping afterwards could delete one that is seconds old if the clock or
  // the retention window were ever misconfigured to zero.
  await sweepQuarantine(config.WA_QUARANTINE_DIR, config.WA_QUARANTINE_RETENTION_DAYS).catch(
    (err: Error) => {
      // Never fatal. Stale credential directories are a liability, but a
      // failure to tidy them is not a reason to refuse to serve.
      log.warn({ err: err.message }, 'quarantine_sweep_failed');
      return { removed: 0, kept: 0 };
    },
  );

  const restored = await registry.restoreAll();
  log.info({ ...restored, operation: 'boot.restore' }, 'instances_restored');

  const sweeper = setInterval(() => {
    void outbox
      .reclaimStale()
      .then((count) => {
        if (count > 0) log.warn({ reclaimed: count }, 'outbox_reclaimed_stale');
      })
      .catch((err: Error) => log.error({ err: err.message }, 'outbox_sweep_failed'));
  }, RECLAIM_INTERVAL_MS);
  // Never hold the process open on this timer alone.
  sweeper.unref();

  // Quarantined sessions hold dead-but-real WhatsApp device identities, so the
  // retention window has to be enforced by something that runs, not only at
  // boot — a gateway that stays up for months would otherwise never sweep.
  const quarantineSweeper = setInterval(() => {
    void sweepQuarantine(config.WA_QUARANTINE_DIR, config.WA_QUARANTINE_RETENTION_DAYS).catch(
      (err: Error) => log.warn({ err: err.message }, 'quarantine_sweep_failed'),
    );
  }, QUARANTINE_SWEEP_INTERVAL_MS);
  quarantineSweeper.unref();

  const app = await buildApp({
    config,
    registry,
    redis,
    outbox,
    sessionDir: config.WA_SESSION_DIR,
    version,
  });

  await app.listen({ host: config.HOST, port: config.PORT });
  log.info({ host: config.HOST, port: config.PORT }, 'gateway_listening');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    // A second SIGTERM during shutdown must not start a second teardown —
    // that races the first and can close a socket mid-write.
    if (shuttingDown) return;
    shuttingDown = true;

    log.info({ signal }, 'gateway_shutting_down');
    clearInterval(sweeper);
    clearInterval(quarantineSweeper);

    const deadline = setTimeout(() => {
      log.error({ timeout_ms: SHUTDOWN_TIMEOUT_MS }, 'gateway_shutdown_timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();

    try {
      // Order matters: stop accepting requests, then release WhatsApp sockets,
      // then drop Redis. Closing Redis first would strand the connector's
      // final QR clears and lock releases.
      await app.close();
      await connector.shutdown();
      await redis.close();
      clearTimeout(deadline);
      log.info('gateway_stopped');
      process.exit(0);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'gateway_shutdown_failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // The logger may not exist yet — a config failure happens before it is
  // constructed — so this deliberately uses console.error rather than risking a
  // second throw that would hide the first.
  console.error('[619-erp-whatsapp] failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
