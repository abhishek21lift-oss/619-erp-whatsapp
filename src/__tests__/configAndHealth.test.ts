// Boot-time configuration and the health/readiness split.

import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../config.js';
import { buildHarness, TEST_GATEWAY_KEY, TEST_WEBHOOK_SECRET, type Harness } from './helpers.js';

const validEnv = {
  WA_GATEWAY_KEY: TEST_GATEWAY_KEY,
  WA_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  WA_BACKEND_URL: 'http://backend.test:5000',
} as NodeJS.ProcessEnv;

describe('configuration', () => {
  it('accepts a complete environment and applies documented defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.PORT).toBe(8080);
    expect(config.WA_QR_TTL_SEC).toBe(60);
    expect(config.WA_MAX_INSTANCES).toBe(50);
    expect(config.REDIS_URL).toBe('redis://redis:6379');
  });

  it('refuses to load without the secrets that ARE the authentication', () => {
    // A default or a skip-the-check branch here would turn a half-configured
    // deploy into an unauthenticated WhatsApp gateway — silently. See config.ts.
    for (const missing of ['WA_GATEWAY_KEY', 'WA_WEBHOOK_SECRET', 'WA_BACKEND_URL']) {
      const env = { ...validEnv };
      delete env[missing];
      expect(() => loadConfig(env), missing).toThrowError(/Invalid environment/);
    }
  });

  it('refuses a secret short enough to have been typed by hand', () => {
    expect(() => loadConfig({ ...validEnv, WA_GATEWAY_KEY: 'hunter2' })).toThrowError(
      /at least 32 characters/,
    );
  });

  it('refuses a backend URL that is not a URL', () => {
    expect(() => loadConfig({ ...validEnv, WA_BACKEND_URL: 'myptstudio-backend' })).toThrowError(
      /Invalid environment/,
    );
  });

  it('reports every problem at once rather than one per restart', () => {
    let message = '';
    try {
      loadConfig({} as NodeJS.ProcessEnv);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('WA_GATEWAY_KEY');
    expect(message).toContain('WA_WEBHOOK_SECRET');
    expect(message).toContain('WA_BACKEND_URL');
  });

  it('rejects an out-of-range numeric override instead of coercing it', () => {
    expect(() => loadConfig({ ...validEnv, PORT: '0' })).toThrowError(/Invalid environment/);
    expect(() => loadConfig({ ...validEnv, WA_MAX_INSTANCES: '99999' })).toThrowError(
      /Invalid environment/,
    );
  });
});

describe('health and readiness', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  it('reports live even when Redis is down', async () => {
    // The distinction that matters: a liveness probe failing on a dependency
    // outage restart-loops a healthy process and drops every live WhatsApp
    // socket on each restart. Architecture §14.3.
    h = await buildHarness({ redisReachable: false });

    const live = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(live.statusCode).toBe(200);
    expect(live.json().status).toBe('ok');

    const ready = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.redis).toBe(false);
  });

  it('reports ready when its dependencies are satisfied', async () => {
    h = await buildHarness({ redisReachable: true });

    const ready = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ready',
      checks: { redis: true, session_dir_writable: true, manifest_loaded: true },
    });
  });

  it('does not reveal which routes exist to an unauthenticated caller', async () => {
    // The auth hook is `onRequest`, which runs BEFORE routing, so an unknown
    // path and a real one are indistinguishable without the key. That ordering
    // is deliberate: route enumeration is free reconnaissance, and refusing
    // before routing costs nothing.
    h = await buildHarness();

    const anonymous = await h.app.inject({ method: 'GET', url: '/no/such/route' });
    expect(anonymous.statusCode).toBe(401);

    const authed = await h.app.inject({
      method: 'GET',
      url: '/no/such/route',
      headers: { 'x-gateway-key': TEST_GATEWAY_KEY },
    });
    expect(authed.statusCode).toBe(404);
    expect(authed.json().error.code).toBeDefined();
  });
});
