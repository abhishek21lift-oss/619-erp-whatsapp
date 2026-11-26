// Inbound WhatsApp text, normalised at the socket boundary.
//
// The ERP is the system of record for the member's thread, so this event is
// the one message event that carries a body. Everything else about the event
// is deliberately boring: a phone number, a type, a timestamp. Protocol
// detail from Baileys stops here.
//
// The cases worth pinning are the ones that would otherwise leak a stranger's
// message into a studio's inbox: our own echo, groups, status broadcasts, and
// a LID-addressed chat with no phone alt.
import { it, expect } from 'vitest';
import { inboundEventFor, inboundEventsFor } from '../domain/inbound.js';
import { EventType } from '../events/schema.js';

const text = (over = {}) => ({
  key: { id: 'WAMSG1', fromMe: false, remoteJid: '919876543210@s.whatsapp.net' },
  pushName: 'Ravi',
  message: { conversation: 'Hello coach' },
  messageTimestamp: 1_700_000_000,
  ...over,
});

it('normalises a 1:1 text into the received payload', () => {
  expect(inboundEventFor(text())).toEqual({
    provider_message_id: 'WAMSG1',
    from_phone: '919876543210',
    push_name: 'Ravi',
    message_type: 'text',
    text: 'Hello coach',
    received_at: new Date(1_700_000_000 * 1000).toISOString(),
  });
});

it('reads extended text and media captions', () => {
  expect(inboundEventFor(text({ message: { extendedTextMessage: { text: 'Hi' } } }))?.text).toBe('Hi');
  expect(inboundEventFor(text({ message: { imageMessage: { caption: 'Progress' } } })))
    .toMatchObject({ message_type: 'image', text: 'Progress' });
  expect(inboundEventFor(text({ message: { audioMessage: {} } })))
    .toMatchObject({ message_type: 'audio', text: null });
  expect(inboundEventFor(text({ message: { documentMessage: {} } })))
    .toMatchObject({ message_type: 'document', text: null });
});

it('labels unknown 1:1 content as other rather than dropping it', () => {
  expect(inboundEventFor(text({ message: { pollCreationMessage: {} } })))
    .toMatchObject({ message_type: 'other', text: null });
});

it('ignores fromMe, groups, status and broadcast', () => {
  expect(inboundEventFor(text({ key: { id: 'x', fromMe: true, remoteJid: '919876543210@s.whatsapp.net' } }))).toBeNull();
  for (const jid of ['120363000000000000@g.us', 'status@broadcast', '123@broadcast']) {
    expect(inboundEventFor(text({ key: { id: 'x', remoteJid: jid } }))).toBeNull();
  }
});

it('uses remoteJidAlt when the chat is LID-addressed', () => {
  expect(inboundEventFor(text({
    key: { id: 'W1', remoteJid: '123456789012345@lid', remoteJidAlt: '919876543210@s.whatsapp.net' },
  }))?.from_phone).toBe('919876543210');
  expect(inboundEventFor(text({
    key: { id: 'W1', remoteJid: '123456789012345@lid' },
  }))).toBeNull();
});

it('caps text at 2000 characters with an ellipsis', () => {
  const payload = inboundEventFor(text({ message: { conversation: 'x'.repeat(2001) } }));
  expect(payload?.text).toHaveLength(2000);
  expect(payload?.text?.endsWith('…')).toBe(true);
  expect(inboundEventFor(text({ message: { conversation: 'x'.repeat(2000) } }))?.text).toHaveLength(2000);
});

it('filters append upserts and preserves notify order', () => {
  expect(inboundEventsFor({ type: 'append', messages: [text()] })).toEqual([]);
  const events = inboundEventsFor({ type: 'notify', messages: [text({ key: { id: 'A', remoteJid: '919876543210@s.whatsapp.net' } }), text({ key: { id: 'B', fromMe: true, remoteJid: '919876543210@s.whatsapp.net' } })] });
  expect(events.map((e) => e.provider_message_id)).toEqual(['A']);
});

it('names the event type the ERP listens for', () => {
  expect(EventType.MESSAGE_RECEIVED).toBe('whatsapp.message.received');
});
