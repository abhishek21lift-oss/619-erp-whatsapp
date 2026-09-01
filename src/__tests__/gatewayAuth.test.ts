// Authentication on the backend → gateway hop (architecture §7.2).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildHarness, authHeaders, newId, ORG_A, TEST_GATEWAY_KEY, type Harness } from './helpers.js';
import { safeEqual } from '../plugins/gatewayAuth.js';

describe('gateway authentication', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('refuses every instance route without a key', async () => {
    const calls = [
      { method: 'GET' as const, url: '/v1/instances' },
      { method: 'GET' as const, url: `/v1/instances/${newId()}` },
      { method: 'POST' as const, url: '/v1/instances' },
      { method: 'DELETE' as const, url: `/v1/instances/${newId()}` },
    ];

    for (const call of calls) {
      const res = await h.app.inject({ ...call, headers: { 'x-org-id': ORG_A } });
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('refuses a wrong key', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/instances',
      headers: { 'x-gateway-key': 'wrong-but-also-quite-long-key-0123456789', 'x-org-id': ORG_A },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a key that is a prefix of the real one', async () => {
    // Guards the length-leak fix in safeEqual: a naive compare that returned
    // early on a length mismatch would answer this faster than a same-length
    // wrong key, which is enough to narrow a brute force.
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/instances',
      headers: { 'x-gateway-key': TEST_GATEWAY_KEY.slice(0, -1), 'x-org-id': ORG_A },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the correct key', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/instances',
      headers: authHeaders(ORG_A),
    });
    expect(res.statusCode).toBe(200);
  });

  it('leaves liveness and readiness public', async () => {
    // Deliberate: Docker's HEALTHCHECK has no credential to present, and
    // requiring one would make the container permanently unhealthy.
    for (const url of ['/healthz', '/readyz']) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('keeps /metrics authenticated', async () => {
    // Per-tenant instance counts are tenant data (architecture §14.3).
    const anonymous = await h.app.inject({ method: 'GET', url: '/metrics' });
    expect(anonymous.statusCode).toBe(401);

    const authed = await h.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: authHeaders(ORG_A),
    });
    expect(authed.statusCode).toBe(200);
  });

  it('never echoes the presented key back to the caller', async () => {
    const secret = 'a-secret-the-attacker-guessed-0123456789abcd';
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/instances',
      headers: { 'x-gateway-key': secret, 'x-org-id': ORG_A },
    });
    expect(res.body).not.toContain(secret);
  });

  describe('safeEqual', () => {
    it('matches identical strings and rejects everything else', () => {
      expect(safeEqual('abc', 'abc')).toBe(true);
      expect(safeEqual('abc', 'abd')).toBe(false);
      // Different lengths must return false, not throw — the raw
      // timingSafeEqual would throw here, which is the bug being guarded.
      expect(safeEqual('short', 'a-much-longer-value')).toBe(false);
      expect(safeEqual('', '')).toBe(true);
    });
  });
});
