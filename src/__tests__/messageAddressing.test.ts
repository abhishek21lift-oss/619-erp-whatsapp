// The two pure pieces of the send path: who a number addresses, and what a
// WhatsApp receipt means.
//
// Both are small, and both are the kind of small that is expensive to get
// wrong. `toJid` decides which human receives a studio's message. The receipt
// table decides what the ERP records as having happened to it. Neither can be
// exercised through the app harness — one is called inside a live Baileys
// send, the other inside a socket event handler — so they are tested here
// directly, which is the reason both are exported.

import { describe, it, expect } from 'vitest';
import { toJid, receiptEventFor } from '../domain/baileysConnector.js';
import { EventType } from '../events/schema.js';

describe('toJid', () => {
  it('addresses an individual chat, never a group', () => {
    // A group JID (@g.us) must be unreachable from a phone number: a bug that
    // broadcast a studio's automation into a group chat is unrecoverable.
    expect(toJid('+919876543210')).toBe('919876543210@s.whatsapp.net');
    expect(toJid('+919876543210')).not.toContain('@g.us');
  });

  it('normalises the formats the ERP actually stores', () => {
    // pt_clients.mobile has been written by several generations of this
    // product; these are all the same person and must reach one JID.
    const expected = '919876543210@s.whatsapp.net';
    for (const stored of ['+919876543210', '919876543210', '+91 98765 43210', '+91-98765-43210']) {
      expect(toJid(stored), stored).toBe(expected);
    }
  });
});

describe('receiptEventFor', () => {
  it('maps a delivery ack to delivered', () => {
    expect(receiptEventFor(3)).toBe(EventType.MESSAGE_DELIVERED);
  });

  it('maps both read and played to read', () => {
    // 5 is PLAYED, which WhatsApp uses for voice notes. For the ERP's purposes
    // the client has seen it, which is what `read` means.
    expect(receiptEventFor(4)).toBe(EventType.MESSAGE_READ);
    expect(receiptEventFor(5)).toBe(EventType.MESSAGE_READ);
  });

  it('ignores server ack, because message.sent already said that', () => {
    // Level 2 is "the server has it". Re-reporting it would move a row
    // backwards in the ERP's status ladder if it landed after a delivery
    // receipt, and WhatsApp does not promise these arrive in order.
    expect(receiptEventFor(2)).toBeNull();
    expect(receiptEventFor(1)).toBeNull();
    expect(receiptEventFor(0)).toBeNull();
  });

  it('ignores an absent status rather than guessing', () => {
    expect(receiptEventFor(undefined)).toBeNull();
    expect(receiptEventFor(null)).toBeNull();
  });
});
