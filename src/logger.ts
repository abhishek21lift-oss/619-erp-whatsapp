// Structured logging (architecture §14).
//
// One logger for the whole service, including Baileys itself once Phase 3
// lands. That is deliberate: Baileys takes a Pino instance, and giving it its
// own logger is precisely how Signal key material ends up in a log file. It
// gets a child of this one, so it inherits the redaction below.

import { pino, type Logger } from 'pino';
import { getConfig } from './config.js';

/**
 * Paths scrubbed from every log record.
 *
 * A deny-list, and an explicit one. The alternative — trusting each call site
 * to pass only safe fields — is the sort of rule that holds for six months and
 * then does not, in the one code path nobody reviewed.
 *
 * `qr` is on this list because a QR string is a pairing credential: anyone who
 * renders and scans it links a device to that studio's WhatsApp account. It is
 * as sensitive as the session it creates.
 */
const REDACT_PATHS = [
  // Inbound credentials
  'req.headers["x-gateway-key"]',
  'req.headers.authorization',
  'req.headers.cookie',

  // Outbound credentials
  'headers["x-gateway-key"]',
  'headers["x-wa-signature"]',

  // Baileys auth state, at every nesting depth we can name
  'creds',
  '*.creds',
  'state.creds',
  '*.privateKey',
  '*.pubKey',
  '*.signedPreKey',
  '*.identityKey',
  '*.signedIdentityKey',
  '*.noiseKey',
  '*.pairingEphemeralKeyPair',

  // Pairing + message content
  'qr',
  '*.qr',
  'payload.qr',
  'payload.body',
  'payload.message',
];

function createRootLogger(): Logger {
  const config = getConfig();

  return pino({
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, remove: true },
    // ISO timestamps rather than epoch millis. These logs are read by a human
    // next to the backend's Pino output during an incident, and the backend
    // uses the same.
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: '619-erp-whatsapp' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Pretty-printing is development-only and loaded lazily, so pino-pretty
    // stays a devDependency and never has to exist in the production image.
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
      : {}),
  });
}

let root: Logger | undefined;

export function getLogger(): Logger {
  root ??= createRootLogger();
  return root;
}

/**
 * A child logger bound to an operation's identifiers.
 *
 * Every operation-scoped line in this service carries request_id, tenant_id and
 * instance_id where they are known (architecture §14.1), because the question
 * asked of these logs during an incident is always "what happened to THIS
 * studio's connection", and a line that cannot answer it is noise.
 */
export function operationLogger(fields: {
  request_id?: string | undefined;
  tenant_id?: string | undefined;
  instance_id?: string | undefined;
  event_id?: string | undefined;
  operation?: string | undefined;
}): Logger {
  const defined = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  return getLogger().child(defined);
}

/** Test seam. Never called by the running service. */
export function setLoggerForTesting(logger: Logger | undefined): void {
  root = logger;
}
