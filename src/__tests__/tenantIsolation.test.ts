// Cross-tenant isolation — the load-bearing security property of this service.
//
// The brief's requirement is absolute: Studio A must never be able to access
// Studio B's instance, read its messages, send through its number, or reach its
// session credentials. This suite covers the first, third and fourth of those
// for every route that exists; messages do not exist yet (Phase 9+).
//
// Every assertion here is deliberately about the RESPONSE CODE as well as the
// body. A 403 would leak the existence of another tenant's instance, and since
// instance ids are UUIDs there is nothing to gain by that disclosure and a real
// enumeration signal to lose. See architecture §7.4 and GatewayError.notFound.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildHarness, authHeaders, newId, ORG_A, ORG_B, type Harness } from './helpers.js';

describe('cross-tenant isolation', () => {
  let h: Harness;
  let instanceA: string;

  beforeEach(async () => {
    h = await buildHarness();
    instanceA = newId();
    await h.registry.create(instanceA, ORG_A);
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("hides A's instance from B on every read route", async () => {
    const routes = [
      `/v1/instances/${instanceA}`,
      `/v1/instances/${instanceA}/status`,
      `/v1/instances/${instanceA}/qr`,
    ];

    for (const url of routes) {
      const res = await h.app.inject({ method: 'GET', url, headers: authHeaders(ORG_B) });
      expect(res.statusCode, `${url} must not disclose another tenant's instance`).toBe(404);
      expect(res.json()).toEqual({
        error: { code: 'INSTANCE_NOT_FOUND', message: 'Instance not found.' },
      });
    }
  });

  it("refuses B's attempts to act on A's instance, and changes nothing", async () => {
    const before = h.connector.calls.length;

    const mutations = [
      { method: 'POST' as const, url: `/v1/instances/${instanceA}/reconnect` },
      { method: 'POST' as const, url: `/v1/instances/${instanceA}/disconnect` },
      { method: 'DELETE' as const, url: `/v1/instances/${instanceA}` },
    ];

    for (const { method, url } of mutations) {
      const res = await h.app.inject({ method, url, headers: authHeaders(ORG_B) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }

    // The real assertion: not merely that the API said no, but that nothing
    // happened. A 404 with a side effect would be worse than a 200.
    expect(h.connector.calls.length).toBe(before);
    expect(h.registry.get(instanceA, ORG_A).instance_id).toBe(instanceA);
  });

  it("never returns A's instance in B's list", async () => {
    const instanceB = newId();
    await h.registry.create(instanceB, ORG_B);

    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/instances',
      headers: authHeaders(ORG_B),
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json().instances as { instance_id: string }[]).map((i) => i.instance_id);
    expect(ids).toEqual([instanceB]);
    expect(ids).not.toContain(instanceA);
  });

  it('refuses to list without an organization rather than returning everything', async () => {
    // The failure mode this guards against is the dangerous one: an omitted
    // scope must never widen to platform-wide. Fail closed, exactly as
    // tenantScope() does in the ERP.
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/instances',
      headers: { 'x-gateway-key': authHeaders(ORG_A)['x-gateway-key'] as string },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a query organization that disagrees with the header', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/instances?organization_id=${ORG_A}`,
      headers: authHeaders(ORG_B),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it("refuses to let B adopt A's instance id by re-creating it", async () => {
    // The nastiest shape of this attack: not reading A's instance, but claiming
    // it. If create() treated an existing id as "already done" without checking
    // the owner, B would receive A's status and, worse, believe it owns it.
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: authHeaders(ORG_B),
      payload: { instance_id: instanceA, organization_id: ORG_B },
    });

    expect(res.statusCode).toBe(404);
    expect(h.registry.get(instanceA, ORG_A).organization_id).toBe(ORG_A);
  });

  it('rejects a body organization that disagrees with the header', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: authHeaders(ORG_A),
      payload: { instance_id: newId(), organization_id: ORG_B },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('does not leak the QR of another tenant even when one is available', async () => {
    h.qr.values.set(instanceA, 'a-real-pairing-credential');

    const mine = await h.app.inject({
      method: 'GET',
      url: `/v1/instances/${instanceA}/qr`,
      headers: authHeaders(ORG_A),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().qr).toBe('a-real-pairing-credential');

    const theirs = await h.app.inject({
      method: 'GET',
      url: `/v1/instances/${instanceA}/qr`,
      headers: authHeaders(ORG_B),
    });
    expect(theirs.statusCode).toBe(404);
    expect(JSON.stringify(theirs.json())).not.toContain('a-real-pairing-credential');
  });
});
