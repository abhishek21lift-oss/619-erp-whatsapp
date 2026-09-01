// Webhook signing for the gateway → backend hop (architecture §7.3).
//
// ── Why this is not just "HMAC the body" ────────────────────────────────────
//
// A signature over the body alone is replayable forever: capture one
// `whatsapp.instance.connected` and you can re-post it next week and the
// signature still verifies. Binding the timestamp INTO the signed material —
// rather than sending it alongside — means an attacker cannot move a captured
// request to a new time without invalidating it.
//
// This mirrors the ERP's routes/razorpay-webhook.js, which verifies an
// HMAC-SHA256 over the raw body with a timing-safe compare, and adds the two
// things that handler lacks and this one needs: a timestamp window, and an
// event id the receiver can use as an idempotency key. At-least-once delivery
// (§11.2) makes duplicates normal, so both are load-bearing rather than
// defensive.

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-wa-signature';
export const TIMESTAMP_HEADER = 'x-wa-timestamp';
export const EVENT_ID_HEADER = 'x-wa-event-id';

/**
 * How far a request's timestamp may be from ours.
 *
 * Five minutes each way. Wide enough to absorb clock skew between two
 * containers and a slow retry; narrow enough that a captured request is useless
 * by the time anyone has finished capturing it.
 *
 * Both directions matter: rejecting only the past would let an attacker replay
 * a request stamped in the future once the clock caught up.
 */
export const TIMESTAMP_TOLERANCE_SEC = 300;

/**
 * The bytes that get signed: `<unix-seconds>.<raw body>`.
 *
 * The separator is deliberate. Without it, `("1", "23")` and `("12", "3")`
 * would produce identical signed material — a canonicalisation ambiguity that
 * lets one valid signature stand for two different requests. A dot cannot
 * appear in an integer timestamp, so the split point is unambiguous.
 */
export function signedPayload(timestampSec: number, rawBody: string): string {
  return `${timestampSec}.${rawBody}`;
}

export function signBody(
  rawBody: string,
  secret: string,
  timestampSec: number = Math.floor(Date.now() / 1000),
): { signature: string; timestamp: string } {
  const mac = createHmac('sha256', secret).update(signedPayload(timestampSec, rawBody), 'utf8');
  return { signature: `sha256=${mac.digest('hex')}`, timestamp: String(timestampSec) };
}

/** Constant-time compare that does not leak length either — see gatewayAuth.ts. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export type VerifyFailure =
  | 'missing_signature'
  | 'missing_timestamp'
  | 'malformed_timestamp'
  | 'stale_timestamp'
  | 'bad_signature';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

/**
 * Verify a signed request.
 *
 * Exported from the gateway although the gateway never calls it: it is the
 * executable specification of what the backend must implement in Phase 7, and
 * it is what the round-trip tests check against. Two hand-written
 * implementations of an HMAC scheme that were never compared is a reliable way
 * to ship a receiver that accepts nothing, or worse, accepts anything.
 *
 * The order of checks is deliberate — cheap and non-cryptographic first, so a
 * malformed request never reaches the HMAC.
 */
export function verifySignature(args: {
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string;
  nowSec?: number;
  toleranceSec?: number;
}): VerifyResult {
  const { rawBody, signature, timestamp, secret } = args;
  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = args.toleranceSec ?? TIMESTAMP_TOLERANCE_SEC;

  if (!signature) return { ok: false, reason: 'missing_signature' };
  if (!timestamp) return { ok: false, reason: 'missing_timestamp' };

  // Deliberately strict: `parseInt` would happily read "300abc" as 300, and
  // `Number('')` is 0, which is a valid-looking epoch in 1970.
  if (!/^\d{1,15}$/.test(timestamp)) return { ok: false, reason: 'malformed_timestamp' };
  const sent = Number(timestamp);

  if (Math.abs(now - sent) > tolerance) return { ok: false, reason: 'stale_timestamp' };

  const expected = signBody(rawBody, secret, sent).signature;
  return safeEqual(signature, expected) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
