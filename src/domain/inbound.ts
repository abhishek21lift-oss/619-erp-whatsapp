// Pure normalisation of a Baileys `messages.upsert` batch into the ERP's
// inbound event payload.
//
// Nothing here touches a socket, a clock or a store, so every decision about
// what counts as a member's message is testable without WhatsApp. The socket
// listener only resolves the tenant and enqueues what this returns.
//
// What must never become an event: our own echo (`fromMe`), group traffic,
// status broadcasts, and a LID-addressed chat with no phone alt. Each of those
// would otherwise put a stranger's message into a studio's inbox.

/** The nine types the ERP stores. Anything unrecognised becomes `other`. */
export type InboundMessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'other';

export interface InboundPayload {
  provider_message_id: string;
  from_phone: string;
  push_name: string | null;
  message_type: InboundMessageType;
  text: string | null;
  received_at: string;
}

interface WAMessageKeyLike {
  id?: string | null;
  fromMe?: boolean | null;
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
}

/**
 * Structural, not Baileys' own type: this module must stay importable by a
 * test with no Baileys session, and the cast happens once at the socket
 * boundary. A Baileys upgrade then changes the connector, not this contract.
 */
export interface WAMessageLike {
  key?: WAMessageKeyLike | null;
  message?: unknown;
  pushName?: string | null;
  messageTimestamp?: number | { toNumber(): number } | null;
}

export interface MessagesUpsertLike {
  type?: string | null;
  messages?: WAMessageLike[] | null;
}

const MAX_TEXT = 2000;

/** A national number is at least 8 digits; 15 is the E.164 maximum. */
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;

const MEDIA_TYPES: Record<string, InboundMessageType> = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  locationMessage: 'location',
  contactMessage: 'contact',
  contactsArrayMessage: 'contact',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * Cap by CODE POINTS, not UTF-16 units.
 *
 * Slicing a surrogate pair in half produces a lone surrogate, which Postgres
 * rejects as invalid UTF-8. The column's limit is characters, so the cap
 * counts characters too.
 */
function capText(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= MAX_TEXT) return text;
  return `${characters.slice(0, MAX_TEXT - 1).join('')}…`;
}

function captionOf(message: Record<string, unknown>): string | null {
  const caption = message['caption'];
  return typeof caption === 'string' && caption.length > 0 ? caption : null;
}

function messageBody(message: Record<string, unknown>): {
  message_type: InboundMessageType;
  text: string | null;
} {
  const conversation = message['conversation'];
  if (typeof conversation === 'string') {
    return { message_type: 'text', text: conversation };
  }

  const extended = asRecord(message['extendedTextMessage']);
  if (extended && typeof extended['text'] === 'string') {
    return { message_type: 'text', text: extended['text'] };
  }

  for (const [key, type] of Object.entries(MEDIA_TYPES)) {
    const media = asRecord(message[key]);
    if (!media) continue;
    return { message_type: type, text: captionOf(media) };
  }

  // A poll, a reaction, an unsupported protocol message — the member sent
  // something. Calling it `other` keeps the thread honest; dropping it would
  // make the trainer see a gap with no explanation.
  return { message_type: 'other', text: null };
}

function toIsoString(timestamp: WAMessageLike['messageTimestamp']): string {
  let seconds: number | null = null;

  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    seconds = timestamp;
  } else if (timestamp && typeof timestamp === 'object' && typeof timestamp.toNumber === 'function') {
    const converted = timestamp.toNumber();
    if (Number.isFinite(converted)) seconds = converted;
  }

  if (seconds === null) return new Date().toISOString();

  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function phoneFromKey(key: WAMessageKeyLike): string | null {
  const remoteJid = key.remoteJid;
  if (!remoteJid) return null;

  // Group and broadcast chats are not a member's inbox. Reject before any
  // alt lookup: a broadcast has no 1:1 counterpart to fall back to.
  if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast')) {
    return null;
  }

  // Baileys 7 addresses some chats by LID, which is an opaque identifier, not
  // a phone. The alt JID is the real one; without it there is nothing safe to
  // match on, and treating LID digits as a phone could link a stranger.
  const jid = remoteJid.endsWith('@lid') ? key.remoteJidAlt : remoteJid;
  if (!jid) return null;

  const digits = (jid.split('@')[0] ?? '').split(':')[0]?.replace(/\D/g, '') ?? '';
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return null;
  return digits;
}

export function inboundEventFor(raw: WAMessageLike): InboundPayload | null {
  const key = raw?.key;
  if (!key || key.fromMe) return null;

  const providerMessageId = key.id;
  if (!providerMessageId) return null;

  const message = asRecord(raw.message);
  if (!message) return null;

  const fromPhone = phoneFromKey(key);
  if (!fromPhone) return null;

  const { message_type, text } = messageBody(message);
  const pushName = typeof raw.pushName === 'string' && raw.pushName.trim().length > 0
    ? raw.pushName.trim()
    : null;

  return {
    provider_message_id: providerMessageId,
    from_phone: fromPhone,
    push_name: pushName,
    message_type,
    text: text === null ? null : capText(text),
    received_at: toIsoString(raw.messageTimestamp),
  };
}

export function inboundEventsFor(upsert: MessagesUpsertLike): InboundPayload[] {
  // `append` is history sync, not new traffic. Only `notify` is a message
  // arriving now, and order is preserved so the ERP stores the conversation
  // in the order WhatsApp delivered it.
  if (upsert?.type !== 'notify') return [];
  return (upsert.messages ?? [])
    .map((message) => inboundEventFor(message))
    .filter((payload): payload is InboundPayload => payload !== null);
}
