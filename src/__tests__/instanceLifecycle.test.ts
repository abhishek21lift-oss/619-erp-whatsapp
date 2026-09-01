// Instance lifecycle: create, QR, reconnect, disconnect, delete, restore.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildHarness, authHeaders, newId, ORG_A, type Harness } from './helpers.js';
import { Manifest } from '../store/manifest.js';
import { InstanceRegistry } from '../domain/registry.js';
import { InstanceState } from '../domain/instance.js';
import path from 'node:path';

describe('instance lifecycle', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('creates an instance and starts pairing', async () => {
    const id = newId();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: authHeaders(ORG_A),
      payload: { instance_id: id, organization_id: ORG_A },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      instance_id: id,
      organization_id: ORG_A,
      state: InstanceState.CONNECTING,
    });
    expect(h.connector.calls).toContain(`start:${id}`);
    expect(h.outbox.typesFor(id)).toContain('whatsapp.instance.created');
  });

  it('treats a repeated create as idempotent rather than a conflict', async () => {
    // The backend retries a create whose response it never received. That retry
    // must not produce a second instance or a 409 the backend has no way to
    // recover from.
    const id = newId();
    const payload = { instance_id: id, organization_id: ORG_A };
    const headers = authHeaders(ORG_A);

    const first = await h.app.inject({ method: 'POST', url: '/v1/instances', headers, payload });
    const second = await h.app.inject({ method: 'POST', url: '/v1/instances', headers, payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(h.registry.list(ORG_A)).toHaveLength(1);
  });

  it('refuses to create past capacity', async () => {
    const small = await buildHarness({ configOverrides: { WA_MAX_INSTANCES: '1' } });
    try {
      await small.registry.create(newId(), ORG_A);
      const res = await small.app.inject({
        method: 'POST',
        url: '/v1/instances',
        headers: authHeaders(ORG_A),
        payload: { instance_id: newId(), organization_id: ORG_A },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('CAPACITY_REACHED');
    } finally {
      await small.cleanup();
    }
  });

  it('returns 410 for a QR that is not available, and 409 once connected', async () => {
    const id = newId();
    await h.registry.create(id, ORG_A);

    const missing = await h.app.inject({
      method: 'GET',
      url: `/v1/instances/${id}/qr`,
      headers: authHeaders(ORG_A),
    });
    expect(missing.statusCode).toBe(410);
    expect(missing.json().error.code).toBe('QR_EXPIRED');

    // A connected instance has no QR and never will. 410 would tell the UI to
    // retry pairing something already paired.
    h.connector.markConnected(id);
    const connected = await h.app.inject({
      method: 'GET',
      url: `/v1/instances/${id}/qr`,
      headers: authHeaders(ORG_A),
    });
    expect(connected.statusCode).toBe(409);
  });

  it('disconnect keeps the instance; delete removes it', async () => {
    const id = newId();
    await h.registry.create(id, ORG_A);

    const disconnected = await h.app.inject({
      method: 'POST',
      url: `/v1/instances/${id}/disconnect`,
      headers: authHeaders(ORG_A),
    });
    expect(disconnected.statusCode).toBe(202);
    // Still registered — this is the reversible pause, and reconnecting from it
    // must not require a new QR scan.
    expect(h.registry.list(ORG_A).map((i) => i.instance_id)).toContain(id);
    expect(h.connector.calls).toContain(`stop:${id}`);
    expect(h.connector.calls).not.toContain(`logout:${id}`);

    const deleted = await h.app.inject({
      method: 'DELETE',
      url: `/v1/instances/${id}`,
      headers: authHeaders(ORG_A),
    });
    expect(deleted.statusCode).toBe(204);
    expect(h.connector.calls).toContain(`logout:${id}`);
    expect(h.registry.list(ORG_A)).toHaveLength(0);
    expect(h.outbox.typesFor(id)).toContain('whatsapp.instance.deleted');
  });

  it('refuses to reconnect an already-connected instance', async () => {
    const id = newId();
    await h.registry.create(id, ORG_A);
    h.connector.markConnected(id);

    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/instances/${id}/reconnect`,
      headers: authHeaders(ORG_A),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INSTANCE_CONFLICT');
  });

  it('restores every instance after a restart, and one failure does not stop the rest', async () => {
    // This is the property behind "Docker restart does not require a QR": the
    // manifest survives, and restore walks it.
    const good1 = newId();
    const bad = newId();
    const good2 = newId();
    for (const id of [good1, bad, good2]) await h.registry.create(id, ORG_A);

    // Rebuild from disk exactly as boot does.
    const manifest = new Manifest(path.join(h.dir, 'instances.json'));
    await manifest.load();
    expect(manifest.list()).toHaveLength(3);

    const fresh = new InstanceRegistry({
      manifest,
      connector: h.connector,
      qr: h.qr,
      outbox: h.outbox,
      maxInstances: 50,
    });

    h.connector.states.clear();
    h.connector.failNextStart = true; // the first start() in the sweep throws

    const result = await fresh.restoreAll();
    expect(result.attempted).toBe(3);
    expect(result.failed).toBe(1);
    // The two healthy instances still came back. One corrupted session must not
    // keep every other studio disconnected.
    expect(result.restored).toBe(2);
  });

  it('rejects malformed input before it reaches the registry', async () => {
    const headers = authHeaders(ORG_A);

    const cases = [
      { url: '/v1/instances/not-a-uuid', method: 'GET' as const },
      { url: '/v1/instances/../../etc/passwd', method: 'GET' as const },
      { url: `/v1/instances/${'x'.repeat(200)}`, method: 'GET' as const },
    ];

    for (const c of cases) {
      const res = await h.app.inject({ ...c, headers });
      // Any 4xx. The exact code varies by who rejects it — Zod gives 400, an
      // over-long URI is refused by Node's HTTP parser with 414 before Fastify
      // ever sees it. The property under test is that malformed input is
      // rejected as the caller's fault and never reaches the registry, not
      // which layer happens to catch it.
      expect(res.statusCode, `${c.url} → ${res.statusCode}`).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, `${c.url} → ${res.statusCode}`).toBeLessThan(500);
    }

    const badBody = await h.app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers,
      payload: { instance_id: 'nope', organization_id: ORG_A },
    });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json().error.code).toBe('VALIDATION_ERROR');

    const noBody = await h.app.inject({ method: 'POST', url: '/v1/instances', headers });
    expect(noBody.statusCode).toBe(400);
  });
});
