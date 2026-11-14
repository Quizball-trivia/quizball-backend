import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import {
  AppError,
  ErrorCode,
  ErrorResponse,
  ValidationError,
} from '../../core/errors.js';
import { getRequestId } from '../../core/request-context.js';
import { logger } from '../../core/logger.js';
import { isPoolAuthenticationProtocolError } from '../../db/connection-errors.js';
import { isPartnerPath, partnerErrorHandler } from '../../modules/partners/partner-errors.js';

/** Extract keys only from an object to avoid logging sensitive values. */
function redactValues(obj: Record<string, unknown> | undefined): string[] {
  if (!obj) return [];
  return Object.keys(obj);
}

const TRANSIENT_DATABASE_ERROR_CODES = new Set([
  '25006', // Read-only pool session: writes are temporarily unavailable.
  'DB_OVERLOADED',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);

/** body-parser / raw-body error types a client causes (https://github.com/expressjs/body-parser#errors). */
const BODY_PARSER_ERRORS = new Map([
  ['entity.too.large', 'Request body too large'],
  ['parameters.too.many', 'Request body too large'],
  ['entity.parse.failed', 'Malformed request body'],
  ['request.size.invalid', 'Malformed request body'],
  ['querystring.parse.rangeError', 'Malformed request body'],
  ['request.aborted', 'Request body aborted'],
  ['encoding.unsupported', 'Unsupported request body encoding'],
  ['charset.unsupported', 'Unsupported request body charset'],
]);

/** Network, pool and read-only failures are availability failures. */
export function isTransientDatabaseError(error: unknown, depth = 0): boolean {
  if (!error || depth > 3 || typeof error !== 'object') return false;
  if (isPoolAuthenticationProtocolError(error)) return true;
  const candidate = error as {
    code?: unknown;
    cause?: unknown;
    details?: unknown;
    errors?: unknown;
  };
  if (
    typeof candidate.code === 'string'
    && TRANSIENT_DATABASE_ERROR_CODES.has(candidate.code.toUpperCase())
  ) {
    return true;
  }
  if (isTransientDatabaseError(candidate.cause, depth + 1)) return true;
  if (isTransientDatabaseError(candidate.details, depth + 1)) return true;
  return Array.isArray(candidate.errors)
    && candidate.errors.some((nested) => isTransientDatabaseError(nested, depth + 1));
}

/**
 * Central error handler middleware.
 * Converts all errors to standard ErrorResponse format.
 * Note: X-Request-ID header is already set by requestIdMiddleware.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (isPartnerPath(req.originalUrl)) {
    partnerErrorHandler(err, req, res, _next);
    return;
  }
  const requestId = getRequestId();

  // Repository adapters can wrap the original driver/admission failure in an
  // AppError. Preserve its retryable 503 semantics instead of leaking a 500.
  if (isTransientDatabaseError(err)) {
    logger.warn(
      {
        err,
        method: req.method,
        path: req.path,
        userId: req.user?.id ?? null,
        userRole: req.user?.role ?? null,
      },
      'Transient database connection failure'
    );
    res.setHeader('Retry-After', '1');
    res.status(503).json({
      code: ErrorCode.DB_OVERLOADED,
      message: 'Database temporarily unavailable',
      details: null,
      request_id: requestId,
    } satisfies ErrorResponse);
    return;
  }

  // The question_payloads trigger refusing a Weekend League import photo on another question.
  const pg = err as { code?: unknown; message?: unknown };
  if (pg.code === '23514' && typeof pg.message === 'string' && pg.message.startsWith('This photo belongs to a Weekend League import')) {
    res.status(400).json({ code: ErrorCode.BAD_REQUEST, message: pg.message, details: null, request_id: requestId } satisfies ErrorResponse);
    return;
  }

  // A body body-parser refused: the client's fault, not a server error. Its message and `body` can quote the request
  // body, so only a fixed message goes out and only the type is logged.
  const bodyError = err as { type?: unknown; status?: unknown };
  const bodyMessage = typeof bodyError.type === 'string' ? BODY_PARSER_ERRORS.get(bodyError.type) : undefined;
  if (bodyMessage && typeof bodyError.status === 'number' && bodyError.status >= 400 && bodyError.status < 500) {
    logger.warn({ type: bodyError.type, status: bodyError.status, method: req.method, path: req.path }, 'Request body refused');
    res.status(bodyError.status).json({ code: ErrorCode.BAD_REQUEST, message: bodyMessage, details: null, request_id: requestId } satisfies ErrorResponse);
    return;
  }

  // Handle AppError (our custom errors)
  if (err instanceof AppError) {
    if (err.code === ErrorCode.RATE_LIMIT_EXCEEDED || err.statusCode === 503) {
      res.setHeader('Retry-After', '1');
    }
    const response: ErrorResponse = {
      code: err.code,
      message: err.message,
      details: err.details,
      request_id: requestId,
    };

    logger.warn(
      {
        err,
        response,
        method: req.method,
        path: req.path,
        userId: req.user?.id ?? null,
        userRole: req.user?.role ?? null,
      },
      'Application error'
    );
    res.status(err.statusCode).json(response);
    return;
  }

  // Handle Zod validation errors (shouldn't reach here if validate middleware is used correctly)
  if (err instanceof ZodError) {
    const validationError = new ValidationError('Validation failed', {
      fieldErrors: err.flatten().fieldErrors,
      formErrors: err.flatten().formErrors,
    });

    const response: ErrorResponse = {
      code: validationError.code,
      message: validationError.message,
      details: validationError.details,
      request_id: requestId,
    };

    logger.warn(
      {
        err,
        response,
        method: req.method,
        path: req.path,
        userId: req.user?.id ?? null,
        userRole: req.user?.role ?? null,
      },
      'Zod validation error'
    );
    res.status(validationError.statusCode).json(response);
    return;
  }

  // Handle generic/unexpected errors
  logger.error(
    {
      err,
      method: req.method,
      path: req.path,
      userId: req.user?.id ?? null,
      userRole: req.user?.role ?? null,
      paramKeys: redactValues(req.params),
      queryKeys: redactValues(req.query as Record<string, unknown>),
    },
    'Unhandled error'
  );

  const response: ErrorResponse = {
    code: ErrorCode.INTERNAL_ERROR,
    message: 'An unexpected error occurred',
    details: null,
    request_id: requestId,
  };

  res.status(500).json(response);
}

/**
 * 404 Not Found handler for unmatched routes.
 * Note: X-Request-ID header is already set by requestIdMiddleware.
 */
export function notFoundHandler(req: Request, res: Response): void {
  const requestId = getRequestId();

  const response: ErrorResponse = {
    code: ErrorCode.NOT_FOUND,
    message: `Route not found: ${req.method} ${req.path}`,
    details: null,
    request_id: requestId,
  };

  res.status(404).json(response);
}
