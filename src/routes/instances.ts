// The instance API (architecture Appendix A).
//
// Every route here is instance-scoped and every one of them resolves the
// caller's organization from the `X-Org-Id` header before doing anything.
//
// ── Why a header the caller controls is safe here ───────────────────────────
//
// It looks like the thing the ERP deliberately removed — `lib/tenant-db.js`
// explains that `?organization_id=` and body fields were dropped because the
// RLS GUC and the application filter could then disagree about the active
// tenant within one request. The difference is what sits on the other end.
// There, the caller is a browser and the header would be user input. Here, the
// only caller that can reach this service at all is the backend (it holds the
// shared key; there is no public port), and the value it sends is derived from
// the authenticated session by `orgIdOf(req)`.
//
// And it is not a lookup key. The registry finds the instance by its own id and
// then asserts the presented organization matches the stored owner — so a wrong
// value cannot select a different instance, only fail. See registry.ts.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GatewayError } from '../errors.js';
import { ORG_HEADER } from '../plugins/gatewayAuth.js';
import type { InstanceRegistry } from '../domain/registry.js';

const uuid = z.uuid();

const createBody = z.object({
  instance_id: uuid,
  organization_id: uuid,
});

const instanceParams = z.object({ id: uuid });

const listQuery = z.object({ organization_id: uuid.optional() });

/**
 * The organization this request acts for.
 *
 * Mandatory on every instance-scoped route. A missing header is a 400 rather
 * than a silent platform-wide scope: "no organization" must never widen what a
 * request can see, which is the same fail-closed rule `tenantScope()` applies
 * in the ERP.
 */
function orgOf(headers: Record<string, unknown>): string {
  const value = headers[ORG_HEADER];
  if (typeof value !== 'string' || value.length === 0) {
    throw GatewayError.validation(`Missing ${ORG_HEADER} header.`);
  }
  const parsed = uuid.safeParse(value);
  if (!parsed.success) {
    throw GatewayError.validation(`${ORG_HEADER} must be a UUID.`);
  }
  return parsed.data;
}

/** Zod → GatewayError, so a bad body produces our error shape, not Fastify's. */
function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || what}: ${i.message}`)
      .join('; ');
    throw GatewayError.validation(detail);
  }
  return result.data;
}

export function registerInstanceRoutes(
  app: FastifyInstance,
  deps: { registry: InstanceRegistry },
): void {
  const { registry } = deps;

  // POST /v1/instances — create and begin pairing.
  //
  // 200 rather than 201 when the instance already exists, so the backend can
  // safely retry a create whose response it never received. See
  // InstanceRegistry.create for why both ids are supplied by the caller.
  app.post('/v1/instances', async (request, reply) => {
    const body = parse(createBody, request.body, 'body');
    const org = orgOf(request.headers as Record<string, unknown>);

    // The body's organization must match the header's. They come from the same
    // place in a correct caller, so a mismatch is a backend bug — and answering
    // it by silently preferring one would hide that bug behind an instance
    // registered to the wrong studio.
    if (body.organization_id !== org) {
      throw GatewayError.validation(
        `organization_id in the body does not match the ${ORG_HEADER} header.`,
      );
    }

    const existed = registry.list(org).some((i) => i.instance_id === body.instance_id);
    const status = await registry.create(body.instance_id, org);
    return reply.code(existed ? 200 : 201).send(status);
  });

  // GET /v1/instances — list this organization's instances.
  //
  // organization_id is required. Without it this would return every instance on
  // the gateway to any authenticated caller, which is precisely the cross-tenant
  // read the whole design is built to prevent.
  app.get('/v1/instances', async (request) => {
    const org = orgOf(request.headers as Record<string, unknown>);
    const query = parse(listQuery, request.query, 'query');

    if (query.organization_id && query.organization_id !== org) {
      throw GatewayError.validation(
        `organization_id does not match the ${ORG_HEADER} header.`,
      );
    }
    return { instances: registry.list(org) };
  });

  app.get('/v1/instances/:id', async (request) => {
    const { id } = parse(instanceParams, request.params, 'params');
    return registry.get(id, orgOf(request.headers as Record<string, unknown>));
  });

  app.get('/v1/instances/:id/status', async (request) => {
    const { id } = parse(instanceParams, request.params, 'params');
    return registry.get(id, orgOf(request.headers as Record<string, unknown>));
  });

  app.get('/v1/instances/:id/qr', async (request) => {
    const { id } = parse(instanceParams, request.params, 'params');
    return registry.qr(id, orgOf(request.headers as Record<string, unknown>));
  });

  // 202, not 200: reconnection is asynchronous. The instance is `connecting`
  // when this returns, not connected, and saying 200 would invite the caller to
  // treat the response as the outcome.
  app.post('/v1/instances/:id/reconnect', async (request, reply) => {
    const { id } = parse(instanceParams, request.params, 'params');
    const status = await registry.reconnect(id, orgOf(request.headers as Record<string, unknown>));
    return reply.code(202).send(status);
  });

  app.post('/v1/instances/:id/disconnect', async (request, reply) => {
    const { id } = parse(instanceParams, request.params, 'params');
    const status = await registry.disconnect(id, orgOf(request.headers as Record<string, unknown>));
    return reply.code(202).send(status);
  });

  // DELETE is the destructive one: it logs out of WhatsApp and destroys the
  // credentials, so the studio must scan a new QR afterwards. `disconnect`
  // above is the reversible pause.
  app.delete('/v1/instances/:id', async (request, reply) => {
    const { id } = parse(instanceParams, request.params, 'params');
    await registry.remove(id, orgOf(request.headers as Record<string, unknown>));
    return reply.code(204).send();
  });
}
