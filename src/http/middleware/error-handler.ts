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

/**
 * Central error handler middleware.
 * Converts all errors to standard ErrorResponse format.
 * Note: X-Request-ID header is already set by requestIdMiddleware.
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = getRequestId();

  // Handle AppError (our custom errors)
  if (err instanceof AppError) {
    const response: ErrorResponse = {
      code: err.code,
      message: err.message,
      details: err.details,
      request_id: requestId,
    };

    logger.warn({ err, response }, 'Application error');
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

    logger.warn({ err, response }, 'Zod validation error');
    res.status(validationError.statusCode).json(response);
    return;
  }

  // Handle generic/unexpected errors
  logger.error({ err }, 'Unhandled error');

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
