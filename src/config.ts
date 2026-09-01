// Environment configuration, validated once at boot.
//
// ── Why this fails the process rather than defaulting ───────────────────────
//
// Two of these values — WA_GATEWAY_KEY and WA_WEBHOOK_SECRET — are the entire
// authentication story between the ERP and this service (architecture §7.2,
// §7.3). A default, a fallback, or an "if unset, skip the check" branch would
// turn a half-configured deploy into an unauthenticated WhatsApp gateway, and
// it would do so silently, which is the worst version of that.
//
// The ERP's own middleware/serviceAuth.js reaches the same conclusion from the
// other direction: it answers 503 rather than accept a claim it has no secret
// to verify. Refusing to boot is that rule applied at the earliest point it can
// be applied.

import { z } from 'zod';

/**
 * The minimum secret length we will accept.
 *
 * 32 bytes of hex is what `openssl rand -hex 32` produces (64 characters) and
 * what the deployment runbook tells an operator to generate. The floor is set
 * at 32 CHARACTERS rather than 64 so a base64 or base64url secret of equivalent
 * entropy is not rejected on formatting grounds — but it is high enough that a
 * hand-typed password cannot pass.
 */
const MIN_SECRET_LENGTH = 32;

/**
 * A required secret.
 *
 * The same remedy is attached to BOTH failure modes — absent and too short —
 * because the operator reading this is looking at a container that will not
 * start, and "expected string, received undefined" tells them what is wrong
 * without telling them what to do about it.
 */
const secret = (name: string) => {
  const remedy = `${name} is required — generate one with \`openssl rand -hex 32\``;
  return z
    .string({ error: remedy })
    .min(MIN_SECRET_LENGTH, `${remedy} (at least ${MIN_SECRET_LENGTH} characters)`);
};

/** An integer read from a string env var, with a default. */
const intFromEnv = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(8080, 1, 65535),
  // 0.0.0.0 inside a container is correct and is NOT a public exposure: the
  // container publishes no host port (architecture §15.3, §16.1), so the only
  // reachable interface is the Docker network. Binding to loopback instead
  // would make the service unreachable from the backend container.
  HOST: z.string().default('0.0.0.0'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  WA_GATEWAY_KEY: secret('WA_GATEWAY_KEY'),
  WA_WEBHOOK_SECRET: secret('WA_WEBHOOK_SECRET'),

  // The ONLY host this service ever makes an outbound HTTP request to.
  // Held as a fixed configuration value precisely so that no caller-supplied
  // URL can ever be fetched — see architecture §7.5 (SSRF).
  WA_BACKEND_URL: z.url({
    error: 'WA_BACKEND_URL is required and must be a full URL, e.g. http://myptstudio-backend:5000',
  }),

  REDIS_URL: z.string().default('redis://redis:6379'),

  /**
   * Which connector backs the WhatsAppConnector port.
   *
   * `baileys` is production. `null` runs the whole service — auth, tenancy,
   * manifest, events — with pairing inert, which is what the rollout in §16.2
   * needs at step 5: the backend and frontend deploy with the feature flag off,
   * and this lets the gateway stand up alongside them without a single socket
   * reaching WhatsApp until somebody decides it should.
   */
  WA_CONNECTOR: z.enum(['baileys', 'null']).default('baileys'),

  WA_SESSION_DIR: z.string().default('/data/sessions'),
  WA_MANIFEST_PATH: z.string().default('/data/instances.json'),
  WA_QUARANTINE_DIR: z.string().default('/data/quarantine'),

  // Placeholder until Phase 9 measures real per-instance memory. The
  // architecture is explicit that this must not ship untested (§21.3).
  WA_MAX_INSTANCES: intFromEnv(50, 1, 1000),

  WA_QR_TTL_SEC: intFromEnv(60, 10, 300),
  WA_QR_MAX_ROUNDS: intFromEnv(5, 1, 20),

  /**
   * How long a new socket may produce NO signal at all before we give up.
   *
   * Not a duplicate of Baileys' own `connectTimeoutMs`. Found by running this
   * against a network that blocks WhatsApp: the WebSocket was refused in under
   * 100ms, and Baileys emitted no `connection.update` whatsoever — no QR, no
   * close, no error. Five minutes later the instance was still `connecting`.
   *
   * In production that is a studio watching a spinner forever the first time
   * the VPS loses egress to WhatsApp, or WhatsApp blocks the IP. Baileys'
   * timeout did not rescue it, so this watchdog exists instead of trusting it.
   *
   * Longer than Baileys' 20s default so its own handling gets first refusal;
   * short enough that the UI reaches a real state while somebody is watching.
   */
  WA_CONNECT_TIMEOUT_MS: intFromEnv(45_000, 5_000, 300_000),

  WA_RECONNECT_BASE_MS: intFromEnv(2_000, 100, 60_000),
  WA_RECONNECT_MAX_MS: intFromEnv(300_000, 1_000, 3_600_000),
  WA_RECONNECT_MAX_ATTEMPTS: intFromEnv(10, 1, 100),

  WA_QUARANTINE_RETENTION_DAYS: intFromEnv(7, 1, 90),

  // Per-instance API rate limit (architecture §18). Guards against a backend
  // bug — a runaway poll loop — not against an attacker, who cannot reach this
  // service at all.
  WA_RATE_LIMIT_MAX: intFromEnv(100, 1, 10_000),
  WA_RATE_LIMIT_WINDOW_MS: intFromEnv(60_000, 1_000, 3_600_000),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Parse and validate an environment. Throws with every problem listed, not
 * just the first — an operator fixing a deploy should get the whole list in
 * one pass rather than discovering the next missing variable on each restart.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new Error(`Invalid environment configuration:\n${problems}`);
}

let cached: Config | undefined;

/**
 * The process-wide config, parsed on first access.
 *
 * Lazy rather than evaluated at import time so that a test can import any
 * module in this service without needing a full valid environment present.
 * Production reaches it immediately from server.ts, so the fail-fast property
 * is unaffected.
 */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test seam. Never called by the running service. */
export function setConfigForTesting(config: Config | undefined): void {
  cached = config;
}
