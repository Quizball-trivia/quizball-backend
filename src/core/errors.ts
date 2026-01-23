/**
 * Error codes matching the Python backend error contract.
 */
export const ErrorCode = {
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR: 'AUTHORIZATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Base application error class.
 * All domain errors should extend this class.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCodeType;
  public readonly details: unknown;

  constructor(
    message: string,
    statusCode = 500,
    code: ErrorCodeType = ErrorCode.INTERNAL_ERROR,
    details: unknown = null
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;

    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace(this, this.constructor);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed', details: unknown = null) {
    super(message, 401, ErrorCode.AUTHENTICATION_ERROR, details);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Not authorized', details: unknown = null) {
    super(message, 403, ErrorCode.AUTHORIZATION_ERROR, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details: unknown = null) {
    super(message, 404, ErrorCode.NOT_FOUND, details);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict', details: unknown = null) {
    super(message, 409, ErrorCode.CONFLICT, details);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details: unknown = null) {
    super(message, 400, ErrorCode.BAD_REQUEST, details);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details: unknown = null) {
    super(message, 422, ErrorCode.VALIDATION_ERROR, details);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests', details: unknown = null) {
    super(message, 429, ErrorCode.RATE_LIMIT_EXCEEDED, details);
  }
}

export class ExternalServiceError extends AppError {
  constructor(message = 'External service error', details: unknown = null) {
    super(message, 502, ErrorCode.EXTERNAL_SERVICE_ERROR, details);
  }
}

/**
 * Standard error response shape.
 */
export interface ErrorResponse {
  code: ErrorCodeType;
  message: string;
  details: unknown;
  request_id: string | null;
}
