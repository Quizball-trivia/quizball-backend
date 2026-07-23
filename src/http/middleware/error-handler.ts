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

/** Extract keys only from an object to avoid logging sensitive values. */
function redactValues(obj: Record<string, unknown> | undefined): string[] {
  if (!obj) return [];
  return Object.keys(obj);
}

const TRANSIENT_DATABASE_ERROR_CODES = new Set([
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

/** Network and pool failures are availability failures, not application bugs. */
export function isTransientDatabaseError(error: unknown, depth = 0): boolean {
  if (!error || depth > 3 || typeof error !== 'object') return false;
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

  // Handle AppError (our custom errors)
  if (err instanceof AppError) {
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
