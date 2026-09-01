// Authentication for the backend → gateway hop (architecture §7.2).
//
// ── This is lifted, deliberately, from the ERP's middleware/serviceAuth.js ───
//
// That file solved the same problem in the other direction (AI service → ERP)
// and its comments explain two things worth keeping rather than rediscovering:
//
//   1. Hash both sides before the constant-time compare. `timingSafeEqual`
//      throws on a length mismatch, and returning early on that throw leaks the
//      secret's LENGTH through response timing — enough to narrow a brute
//      force. Hashing first makes every comparison run over exactly 32 bytes
//      regardless of what was presented.
//
//   2. Never log the presented value. A near-miss is the single most useful
//      thing an attacker could get written into your log file.
//
// Where this differs: serviceAuth is an ATTESTATION and is optional — a browser
// with no such header proceeds as a normal client. Here the header is the whole
// credential and there is no other kind of caller, so a missing one is a 401
// rather than a pass-through.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { GatewayError, toErrorBody } from '../errors.js';
import { getLogger } from '../logger.js';

export const GATEWAY_KEY_HEADER = 'x-gateway-key';
export const ORG_HEADER = 'x-org-id';
export const REQUEST_ID_HEADER = 'x-request-id';

/** Constant-time compare that does not leak length either. */
export function safeEqual(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Reject any request that does not present the shared key.
 *
 * Registered as an `onRequest` hook — the earliest point in Fastify's lifecycle
 * — so an unauthenticated request is refused before body parsing, before
 * validation, and before it can consume anything more interesting than a socket.
 */
export function registerGatewayAuth(
  app: FastifyInstance,
  options: { expectedKey: string; publicPaths: readonly string[] },
): void {
  const log = getLogger();
  const publicPaths = new Set(options.publicPaths);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (publicPaths.has(request.routeOptions.url ?? request.url)) return;

    const presented = request.headers[GATEWAY_KEY_HEADER];

    if (typeof presented !== 'string' || presented.length === 0) {
      log.warn(
        { path: request.url, ip: request.ip, status: 'error' },
        'gateway_auth_missing',
      );
      const error = GatewayError.unauthorized('Missing service credential.');
      await reply.code(error.statusCode).send(toErrorBody(error));
      return;
    }

    if (!safeEqual(presented, options.expectedKey)) {
      // No presented value in this line. See the header comment.
      log.warn({ path: request.url, ip: request.ip, status: 'error' }, 'gateway_auth_rejected');
      const error = GatewayError.unauthorized();
      await reply.code(error.statusCode).send(toErrorBody(error));
      return;
    }
  });
}
