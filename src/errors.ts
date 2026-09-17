// Typed errors and the stable error codes the ERP depends on.
//
// The ERP will branch on `error.code`, never on the message text, so the codes
// here are a contract (architecture §14.5) and changing one is a breaking
// change. Messages are for humans and may be reworded freely.

/** Every code this service can return. Matches architecture §14.5. */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INSTANCE_NOT_FOUND: 'INSTANCE_NOT_FOUND',
  INSTANCE_CONFLICT: 'INSTANCE_CONFLICT',
  /**
   * The instance exists and belongs to the caller, but there is no live
   * WhatsApp socket to send on.
   *
   * Deliberately its own code rather than an INSTANCE_CONFLICT. The backend has
   * to tell "your studio has not connected WhatsApp / it dropped" — which is
   * retryable and a thing the studio can fix — apart from "you asked to pair
   * something already paired", which is neither. One code for both would make
   * the retry decision unmakeable.
   */
  INSTANCE_NOT_CONNECTED: 'INSTANCE_NOT_CONNECTED',
  /** A send whose client_message_id is already in flight on this instance. */
  DUPLICATE_MESSAGE: 'DUPLICATE_MESSAGE',
  /**
   * The number is not registered on WhatsApp.
   *
   * Its own code, and a permanent one, because of what happens without it.
   * `sock.sendMessage` to a JID nobody owns does not fail — it resolves with a
   * message key exactly like a real send — so a message addressed to a number
   * that is not on WhatsApp was accepted, acknowledged, recorded 'sent' by the
   * ERP, and never received by anyone. Eight of them went out that way in
   * production before the missing delivery receipts gave it away.
   *
   * Retrying cannot help: the number will not be on WhatsApp on the second
   * attempt either. So the ERP must be able to tell this apart from a
   * transport blip, which is what a distinct code is for.
   */
  RECIPIENT_NOT_ON_WHATSAPP: 'RECIPIENT_NOT_ON_WHATSAPP',
  QR_EXPIRED: 'QR_EXPIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  CAPACITY_REACHED: 'CAPACITY_REACHED',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  NOT_READY: 'NOT_READY',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class GatewayError extends Error {
  readonly code: ErrorCodeValue;
  readonly statusCode: number;
  /** Extra fields for the log line only. Never serialised to the response. */
  readonly context: Record<string, unknown>;

  constructor(
    code: ErrorCodeValue,
    statusCode: number,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
  }

  static validation(message: string, context?: Record<string, unknown>): GatewayError {
    return new GatewayError(ErrorCode.VALIDATION_ERROR, 400, message, context);
  }

  static unauthorized(message = 'Invalid or missing service credential.'): GatewayError {
    return new GatewayError(ErrorCode.UNAUTHORIZED, 401, message);
  }

  /**
   * Also the answer when an instance exists but belongs to another tenant.
   *
   * 403 would confirm the instance exists, which is a fact a caller scoped to a
   * different organization has no business learning. 404 is also simply true
   * from that caller's position: within their tenant, it does not exist.
   * Architecture §7.4.
   */
  static notFound(instanceId?: string): GatewayError {
    return new GatewayError(
      ErrorCode.INSTANCE_NOT_FOUND,
      404,
      'Instance not found.',
      instanceId ? { instance_id: instanceId } : {},
    );
  }

  static conflict(message: string, context?: Record<string, unknown>): GatewayError {
    return new GatewayError(ErrorCode.INSTANCE_CONFLICT, 409, message, context);
  }

  /**
   * 409 rather than 503: the gateway is perfectly healthy, this studio's
   * WhatsApp is not. A 503 would tell the caller to retry against the service,
   * and no amount of retrying reconnects a socket only the studio can restore
   * by scanning a QR.
   */
  static notConnected(state: string): GatewayError {
    return new GatewayError(
      ErrorCode.INSTANCE_NOT_CONNECTED,
      409,
      'WhatsApp is not connected for this instance.',
      { state },
    );
  }

  /**
   * A send already in flight under the same client_message_id.
   *
   * 409 and not an error the caller should paper over: it means two deliveries
   * of one logical message raced. Answering "fine" would be a lie about which
   * of them reached the client.
   */
  static duplicateMessage(clientMessageId: string): GatewayError {
    return new GatewayError(
      ErrorCode.DUPLICATE_MESSAGE,
      409,
      'A message with this client_message_id is already being sent.',
      { client_message_id: clientMessageId },
    );
  }

  /**
   * 422, not 400: the request is well-formed and the number is a valid E.164
   * one. What is wrong is a fact about the world — nobody has that number on
   * WhatsApp — which is precisely what "unprocessable" means.
   */
  static recipientNotOnWhatsApp(context?: Record<string, unknown>): GatewayError {
    return new GatewayError(
      ErrorCode.RECIPIENT_NOT_ON_WHATSAPP,
      422,
      'That number is not registered on WhatsApp.',
      context,
    );
  }

  static qrExpired(): GatewayError {
    return new GatewayError(
      ErrorCode.QR_EXPIRED,
      410,
      'No QR is currently available. Start a new pairing attempt.',
    );
  }

  /**
   * A send refused by the per-instance token bucket or daily cap (architecture
   * §18, "Send"). 429, with a `retry_after_ms` the ERP's worker should honour
   * rather than retrying immediately — this is a load-shedding refusal, not a
   * transport failure, and retrying it fast is exactly the "fixed-interval
   * sending" pattern (§19) the limiter exists to prevent.
   */
  static rateLimited(retryAfterMs: number, reason: 'burst' | 'daily_cap'): GatewayError {
    return new GatewayError(
      ErrorCode.RATE_LIMITED,
      429,
      reason === 'daily_cap'
        ? 'This instance has reached its daily send limit.'
        : 'Sending too fast for this instance — slow down and retry shortly.',
      { retry_after_ms: retryAfterMs, reason },
    );
  }

  static capacityReached(max: number): GatewayError {
    return new GatewayError(
      ErrorCode.CAPACITY_REACHED,
      503,
      'This gateway is at its configured instance capacity.',
      { max_instances: max },
    );
  }

  static notReady(reason: string): GatewayError {
    return new GatewayError(ErrorCode.NOT_READY, 503, 'Gateway is not ready.', { reason });
  }

  static internal(message: string, context?: Record<string, unknown>): GatewayError {
    return new GatewayError(ErrorCode.INTERNAL, 500, message, context);
  }
}

/** The wire shape. Nothing else is ever sent in an error response body. */
export interface ErrorBody {
  error: { code: ErrorCodeValue; message: string };
}

export function toErrorBody(error: GatewayError): ErrorBody {
  return { error: { code: error.code, message: error.message } };
}
