// Shared fakes and an app builder for the test suite.
//
// The fakes exist so that the tests which matter most — tenant isolation and
// authentication — have no external dependency at all. A security test that
// only runs when Redis happens to be up is a security test that will one day
// be quietly skipped in CI.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../app.js';
import { loadConfig, setConfigForTesting, type Config } from '../config.js';
import { setLoggerForTesting } from '../logger.js';
import { Manifest } from '../store/manifest.js';
import { InstanceRegistry } from '../domain/registry.js';
import { InstanceState, type InstanceStateValue, type WhatsAppConnector } from '../domain/instance.js';
import type { QrReader, StoredQr } from '../store/qr.js';
import type { EventSink } from '../events/outbox.js';
import type { SendLedger, SendClaim } from '../store/sendLedger.js';
import type { GatewayEvent, EventTypeValue, EventPayloads } from '../events/schema.js';
import { buildEvent } from '../events/schema.js';
import type { RedisHandle } from '../store/redis.js';
import { ensureDir } from '../store/paths.js';

export const TEST_GATEWAY_KEY = 'test-gateway-key-that-is-long-enough-0123456789';
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret-that-is-long-enough-01234567';

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';

export function newId(): string {
  return randomUUID();
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    WA_GATEWAY_KEY: TEST_GATEWAY_KEY,
    WA_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    WA_BACKEND_URL: 'http://backend.test:5000',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

/**
 * A connector whose state can be driven from a test.
 *
 * Deliberately more capable than NullConnector: the lifecycle tests need to
 * simulate a successful pairing, which the real Phase 2 placeholder can never
 * report. That is the whole reason WhatsAppConnector is a port.
 */
export class FakeConnector implements WhatsAppConnector {
  readonly states = new Map<string, InstanceStateValue>();
  readonly calls: string[] = [];
  /** Set to make the next start() throw, for the restore-failure path. */
  failNextStart = false;

  start(instanceId: string): Promise<InstanceStateValue> {
    this.calls.push(`start:${instanceId}`);
    if (this.failNextStart) {
      this.failNextStart = false;
      return Promise.reject(new Error('simulated start failure'));
    }
    this.states.set(instanceId, InstanceState.CONNECTING);
    return Promise.resolve(InstanceState.CONNECTING);
  }

  stop(instanceId: string): Promise<void> {
    this.calls.push(`stop:${instanceId}`);
    this.states.set(instanceId, InstanceState.DISCONNECTED);
    return Promise.resolve();
  }

  logout(instanceId: string): Promise<void> {
    this.calls.push(`logout:${instanceId}`);
    this.states.delete(instanceId);
    return Promise.resolve();
  }

  /** Every send this connector was asked to make, in order. */
  readonly sent: { instanceId: string; to: string; text: string }[] = [];
  /** Set to make the next sendText throw, for the failure-event path. */
  failNextSend: string | null = null;
  #messageSeq = 0;

  sendText(instanceId: string, to: string, text: string): Promise<{ provider_message_id: string }> {
    this.calls.push(`send:${instanceId}`);
    if (this.failNextSend) {
      const reason = this.failNextSend;
      this.failNextSend = null;
      return Promise.reject(new Error(reason));
    }
    // Mirrors the real connector's refusal rather than trusting the registry
    // to have checked: a test that passes only because the fake is permissive
    // proves nothing about the guard.
    if (this.states.get(instanceId) !== InstanceState.CONNECTED) {
      return Promise.reject(new Error(`Instance is not connected (state: ${this.stateOf(instanceId)}).`));
    }
    this.sent.push({ instanceId, to, text });
    this.#messageSeq += 1;
    return Promise.resolve({ provider_message_id: `WAMSG${this.#messageSeq}` });
  }

  stateOf(instanceId: string): InstanceStateValue {
    return this.states.get(instanceId) ?? InstanceState.NEVER_CONNECTED;
  }

  detailsOf(instanceId: string) {
    const connected = this.states.get(instanceId) === InstanceState.CONNECTED;
    return {
      phone_e164: connected ? '+919999999999' : null,
      connected_at: connected ? '2026-09-01T10:00:00.000Z' : null,
      disconnected_at: null,
      last_error_code: null,
    };
  }

  shutdown(): Promise<void> {
    this.states.clear();
    return Promise.resolve();
  }

  /** Test-only: pretend a QR was scanned. */
  markConnected(instanceId: string): void {
    this.states.set(instanceId, InstanceState.CONNECTED);
  }
}

export class FakeQrStore implements QrReader {
  readonly values = new Map<string, string>();

  get(instanceId: string): Promise<StoredQr | undefined> {
    const qr = this.values.get(instanceId);
    return Promise.resolve(qr ? { qr, expires_in_ms: 20_000 } : undefined);
  }

  clear(instanceId: string): Promise<void> {
    this.values.delete(instanceId);
    return Promise.resolve();
  }
}

/**
 * An in-memory stand-in for RedisSendLedger.
 *
 * Deliberately implements the real claim/record/release semantics rather than
 * always answering "fresh": the send-once tests are about that state machine,
 * and a permissive fake would let them pass against a registry that never
 * consulted the ledger at all.
 */
export class FakeSendLedger implements SendLedger {
  /** key → provider id, or null while a send is in flight. */
  readonly entries = new Map<string, string | null>();

  static #key(instanceId: string, clientMessageId: string): string {
    return `${instanceId}:${clientMessageId}`;
  }

  claim(instanceId: string, clientMessageId: string): Promise<SendClaim> {
    const key = FakeSendLedger.#key(instanceId, clientMessageId);
    if (this.entries.has(key)) {
      return Promise.resolve({ fresh: false, provider_message_id: this.entries.get(key) ?? null });
    }
    this.entries.set(key, null);
    return Promise.resolve({ fresh: true, provider_message_id: null });
  }

  record(instanceId: string, clientMessageId: string, providerMessageId: string): Promise<void> {
    this.entries.set(FakeSendLedger.#key(instanceId, clientMessageId), providerMessageId);
    return Promise.resolve();
  }

  release(instanceId: string, clientMessageId: string): Promise<void> {
    this.entries.delete(FakeSendLedger.#key(instanceId, clientMessageId));
    return Promise.resolve();
  }
}

export class FakeOutbox implements EventSink {
  readonly events: GatewayEvent[] = [];

  enqueue<T extends EventTypeValue>(
    eventType: T,
    args: {
      instanceId: string;
      tenantId: string;
      payload: T extends keyof EventPayloads ? EventPayloads[T] : Record<string, unknown>;
      occurredAt?: Date;
    },
  ): Promise<GatewayEvent> {
    const event = buildEvent(eventType, {
      eventId: randomUUID(),
      instanceId: args.instanceId,
      tenantId: args.tenantId,
      payload: args.payload,
      ...(args.occurredAt ? { occurredAt: args.occurredAt } : {}),
    });
    this.events.push(event);
    return Promise.resolve(event);
  }

  typesFor(instanceId: string): string[] {
    return this.events.filter((e) => e.instance_id === instanceId).map((e) => e.event_type);
  }

  depth(): Promise<{ pending: number; processing: number; retrying: number; dead: number }> {
    return Promise.resolve({ pending: this.events.length, processing: 0, retrying: 0, dead: 0 });
  }
}

export const fakeRedis = (reachable = true): RedisHandle =>
  ({
    client: undefined as never,
    ping: () => Promise.resolve(reachable),
    close: () => Promise.resolve(),
  }) satisfies RedisHandle;

export interface Harness {
  app: FastifyInstance;
  registry: InstanceRegistry;
  connector: FakeConnector;
  qr: FakeQrStore;
  outbox: FakeOutbox;
  sendLedger: FakeSendLedger;
  dir: string;
  cleanup(): Promise<void>;
}

/**
 * Build a fully wired app over a real temp directory.
 *
 * The manifest is deliberately NOT faked — it writes to a real filesystem, so
 * the atomic-write and idempotency behaviour is exercised by every test rather
 * than only by the one that names it.
 */
export async function buildHarness(
  options: { redisReachable?: boolean; configOverrides?: Record<string, string> } = {},
): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wa-gw-test-'));

  const config = testConfig({
    WA_SESSION_DIR: path.join(dir, 'sessions'),
    WA_MANIFEST_PATH: path.join(dir, 'instances.json'),
    WA_QUARANTINE_DIR: path.join(dir, 'quarantine'),
    ...options.configOverrides,
  });
  setConfigForTesting(config);
  setLoggerForTesting(pino({ level: 'silent' }));

  // Mirrors server.ts's boot sequence. Without it /readyz correctly reports
  // not-ready because the session directory does not exist — which is the
  // check doing its job, and exactly the signal that caught this omission.
  await ensureDir(config.WA_SESSION_DIR);

  const manifest = new Manifest(config.WA_MANIFEST_PATH);
  await manifest.load();

  const connector = new FakeConnector();
  const qr = new FakeQrStore();
  const outbox = new FakeOutbox();
  const sendLedger = new FakeSendLedger();

  const registry = new InstanceRegistry({
    manifest,
    connector,
    qr,
    outbox,
    sendLedger,
    maxInstances: config.WA_MAX_INSTANCES,
  });

  const app = await buildApp({
    config,
    registry,
    redis: fakeRedis(options.redisReachable ?? true),
    outbox,
    sessionDir: config.WA_SESSION_DIR,
    version: '0.0.0-test',
  });

  return {
    app,
    registry,
    connector,
    qr,
    outbox,
    sendLedger,
    dir,
    async cleanup() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
      setConfigForTesting(undefined);
      setLoggerForTesting(undefined);
    },
  };
}

/** Headers for an authenticated call acting for `org`. */
export function authHeaders(org: string): Record<string, string> {
  return { 'x-gateway-key': TEST_GATEWAY_KEY, 'x-org-id': org };
}
