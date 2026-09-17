// Sending a message: ownership, connection state, send-once, and receipts.
//
// ── What this suite is really about ─────────────────────────────────────────
//
// Everything else in this service is a lifecycle operation whose worst failure
// is a studio seeing the wrong state on a settings card. Sending is different:
// a message that goes out cannot be recalled, and one that goes out from the
// WRONG studio's number shows a stranger's business name to somebody's client.
//
// So the order of checks in registry.sendMessage is itself the thing under
// test — own it, then is it connected, then claim the id, then send — and each
// test below fails if that order is disturbed, not merely if a check is
// deleted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildHarness, authHeaders, newId, ORG_A, ORG_B, type Harness } from './helpers.js';

const TO = '+919876543210';

describe('outbound messages', () => {
  let h: Harness;
  let instanceA: string;

  beforeEach(async () => {
    h = await buildHarness();
    instanceA = newId();
    await h.registry.create(instanceA, ORG_A);
    h.connector.markConnected(instanceA);
  });

  afterEach(async () => {
    await h.cleanup();
  });

  const send = (body: Record<string, unknown>, org = ORG_A, instance = instanceA) =>
    h.app.inject({
      method: 'POST',
      url: `/v1/instances/${instance}/messages`,
      headers: authHeaders(org),
      payload: body,
    });

  describe('the happy path', () => {
    it('sends on the connected socket and returns the provider message id', async () => {
      const res = await send({ to: TO, text: 'Session at 7am', client_message_id: 'cm-1' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ provider_message_id: 'WAMSG1', duplicate: false });
      expect(h.connector.sent).toEqual([
        { instanceId: instanceA, to: TO, text: 'Session at 7am' },
      ]);
    });

    it('emits message.sent carrying both ids, so the ERP can correlate receipts', async () => {
      await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });

      const sent = h.outbox.events.filter((e) => e.event_type === 'whatsapp.message.sent');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.tenant_id).toBe(ORG_A);
      expect(sent[0]?.payload).toMatchObject({
        client_message_id: 'cm-1',
        provider_message_id: 'WAMSG1',
      });
    });

    it('puts no message text in the event', async () => {
      // The body belongs in the ERP's communication_logs, not in this
      // service's outbox, its retry ZSET, or the backend's request logs.
      await send({ to: TO, text: 'a private note to a client', client_message_id: 'cm-1' });

      const serialised = JSON.stringify(h.outbox.events);
      expect(serialised).not.toContain('a private note to a client');
    });
  });

  describe('tenant isolation', () => {
    it("refuses B's send on A's instance with 404, and sends nothing", async () => {
      const res = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' }, ORG_B);

      // 404, not 403: a 403 confirms A's instance exists.
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: { code: 'INSTANCE_NOT_FOUND', message: 'Instance not found.' },
      });
      // The assertion that matters: not that the API said no, but that no
      // message left the socket.
      expect(h.connector.sent).toEqual([]);
      expect(h.outbox.events.some((e) => e.event_type.startsWith('whatsapp.message'))).toBe(false);
    });

    it('checks ownership BEFORE the connection state', async () => {
      // A disconnected instance of A's, addressed by B. If state were checked
      // first, B would learn that A's instance exists and is disconnected —
      // the ordering is the disclosure, not the check itself.
      const disconnected = newId();
      await h.registry.create(disconnected, ORG_A);

      const res = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' }, ORG_B, disconnected);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('INSTANCE_NOT_FOUND');
    });

    it('does not let B reuse a client_message_id to learn about A', async () => {
      await send({ to: TO, text: 'hi', client_message_id: 'shared-id' });
      const before = h.sendLedger.entries.size;

      const res = await send({ to: TO, text: 'hi', client_message_id: 'shared-id' }, ORG_B);
      expect(res.statusCode).toBe(404);
      // B's attempt must not touch the ledger either — an entry keyed on B's
      // instance would be a write on a refused request.
      expect(h.sendLedger.entries.size).toBe(before);
    });
  });

  describe('connection state', () => {
    it('refuses to send when WhatsApp is not connected', async () => {
      const idle = newId();
      await h.registry.create(idle, ORG_A);

      const res = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' }, ORG_A, idle);

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('INSTANCE_NOT_CONNECTED');
      expect(h.connector.sent).toEqual([]);
    });

    it('emits no failure event for a send that was never attempted', async () => {
      // A message.failed here would put a failed row in communication_logs for
      // a message the ERP never actually tried to deliver. The instance
      // connection events already tell it why.
      const idle = newId();
      await h.registry.create(idle, ORG_A);
      await send({ to: TO, text: 'hi', client_message_id: 'cm-1' }, ORG_A, idle);

      expect(h.outbox.events.some((e) => e.event_type === 'whatsapp.message.failed')).toBe(false);
    });

    it('leaves the client_message_id unclaimed so a later retry can send', async () => {
      const idle = newId();
      await h.registry.create(idle, ORG_A);
      await send({ to: TO, text: 'hi', client_message_id: 'cm-1' }, ORG_A, idle);

      // The studio reconnects and the ERP retries the same job.
      h.connector.markConnected(idle);
      const retry = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' }, ORG_A, idle);

      expect(retry.statusCode).toBe(200);
      expect(retry.json().duplicate).toBe(false);
      expect(h.connector.sent).toHaveLength(1);
    });
  });

  describe('send rate limiting (architecture §18)', () => {
    // Deep-audit finding: the only rate limiting actually wired up used to be
    // the generic per-org API limiter, which throttles how often the ERP may
    // CALL this service, not how much WhatsApp volume goes out. A backend bug
    // calling this endpoint in a loop had no gateway-side guardrail against
    // "fixed-interval sending is a machine signature" (§19).

    it('refuses a send the token bucket denies, with 429 and nothing sent', async () => {
      h.rateLimiter.denyNext = { allowed: false, retryAfterMs: 2_500, reason: 'burst' };

      const res = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });

      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('RATE_LIMITED');
      expect(h.connector.sent).toEqual([]);
    });

    it('checks the rate limit BEFORE claiming the send-once id', async () => {
      // Nothing was attempted, so the ERP's retry of the exact same message
      // once it backs off must see a FRESH claim, not "already in flight".
      h.rateLimiter.denyNext = { allowed: false, retryAfterMs: 1_000, reason: 'burst' };
      const refused = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });
      expect(refused.statusCode).toBe(429);

      const retry = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().duplicate).toBe(false);
    });

    it('emits no message event for a send the rate limiter refused', async () => {
      h.rateLimiter.denyNext = { allowed: false, retryAfterMs: 1_000, reason: 'burst' };
      await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });

      expect(h.outbox.events.some((e) => e.event_type.startsWith('whatsapp.message'))).toBe(false);
    });

    it('a daily-cap refusal is distinguishable from a burst refusal', async () => {
      h.rateLimiter.denyNext = { allowed: false, retryAfterMs: 86_400_000, reason: 'daily_cap' };

      const res = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });

      expect(res.statusCode).toBe(429);
      expect(res.json().error.message).toMatch(/daily/i);
    });

    it('checks connection state before the rate limit, consistent with the documented order', async () => {
      const idle = newId();
      await h.registry.create(idle, ORG_A);
      h.rateLimiter.denyNext = { allowed: false, retryAfterMs: 1_000, reason: 'burst' };

      const res = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' }, ORG_A, idle);

      // NOT_CONNECTED, not RATE_LIMITED — the rate limiter is never consulted
      // for an instance with no live socket to send on.
      expect(res.json().error.code).toBe('INSTANCE_NOT_CONNECTED');
      expect(h.rateLimiter.calls).toEqual([]);
    });
  });

  describe('send-once under retry', () => {
    it('returns the original provider id instead of sending twice', async () => {
      const first = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });
      const replay = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });

      expect(first.json().provider_message_id).toBe('WAMSG1');
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ provider_message_id: 'WAMSG1', duplicate: true });

      // The whole point: the client received this once.
      expect(h.connector.sent).toHaveLength(1);
    });

    it('emits message.sent once, so the ERP does not log two sends', async () => {
      await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });
      await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });

      expect(h.outbox.events.filter((e) => e.event_type === 'whatsapp.message.sent')).toHaveLength(1);
    });

    it('refuses a concurrent send under the same id rather than racing it', async () => {
      // Claimed but not yet recorded — the window a second attempt hits when
      // the first one is still in flight.
      await h.sendLedger.claim(instanceA, 'cm-inflight');

      const res = await send({ to: TO, text: 'hi', client_message_id: 'cm-inflight' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DUPLICATE_MESSAGE');
      expect(h.connector.sent).toEqual([]);
    });

    it('treats a different client_message_id as a different message', async () => {
      await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });
      await send({ to: TO, text: 'hi', client_message_id: 'cm-2' });
      expect(h.connector.sent).toHaveLength(2);
    });
  });

  describe('when the send fails', () => {
    it('reports 500, emits message.failed, and releases the claim', async () => {
      h.connector.failNextSend = 'socket closed mid-send';

      const res = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });
      expect(res.statusCode).toBe(500);

      const failed = h.outbox.events.filter((e) => e.event_type === 'whatsapp.message.failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toMatchObject({ client_message_id: 'cm-1', will_retry: true });

      // Released, so the ERP's next attempt is not refused as a duplicate of a
      // message that never left.
      const retry = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });
      expect(retry.statusCode).toBe(200);
      expect(h.connector.sent).toHaveLength(1);
    });

    it('does not leak the underlying error to the caller', async () => {
      h.connector.failNextSend = 'ECONNREFUSED 10.0.0.7:443 while dialling wa.example';
      const res = await send({ to: TO, text: 'hi', client_message_id: 'cm-1' });
      expect(res.json().error.message).not.toContain('10.0.0.7');
    });
  });

  describe('input validation', () => {
    it.each([
      ['a missing recipient', { text: 'hi', client_message_id: 'c' }],
      ['a non-numeric recipient', { to: 'not-a-number', text: 'hi', client_message_id: 'c' }],
      ['a recipient with a leading zero', { to: '+0123456789', text: 'hi', client_message_id: 'c' }],
      ['empty text', { to: TO, text: '', client_message_id: 'c' }],
      ['a missing client_message_id', { to: TO, text: 'hi' }],
      ['text past WhatsApp\'s limit', { to: TO, text: 'x'.repeat(4097), client_message_id: 'c' }],
    ])('rejects %s with 400 and sends nothing', async (_label, body) => {
      const res = await send(body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(h.connector.sent).toEqual([]);
    });

    it('accepts an E.164 number without the leading plus', async () => {
      // pt_clients.mobile is stored both ways across the ERP's history.
      const res = await send({ to: '919876543210', text: 'hi', client_message_id: 'cm-1' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('authentication', () => {
    it('refuses a send with no gateway key', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/instances/${instanceA}/messages`,
        headers: { 'x-org-id': ORG_A },
        payload: { to: TO, text: 'hi', client_message_id: 'cm-1' },
      });
      expect(res.statusCode).toBe(401);
      expect(h.connector.sent).toEqual([]);
    });

    it('refuses a send with no organization header', async () => {
      const { 'x-org-id': _omitted, ...noOrg } = authHeaders(ORG_A);
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/instances/${instanceA}/messages`,
        headers: noOrg,
        payload: { to: TO, text: 'hi', client_message_id: 'cm-1' },
      });
      expect(res.statusCode).toBe(400);
      expect(h.connector.sent).toEqual([]);
    });
  });
});
