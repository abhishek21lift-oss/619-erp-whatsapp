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

  static qrExpired(): GatewayError {
    return new GatewayError(
      ErrorCode.QR_EXPIRED,
      410,
      'No QR is currently available. Start a new pairing attempt.',
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
