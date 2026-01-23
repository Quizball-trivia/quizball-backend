import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithRequestContext } from '../../core/request-context.js';

const REQUEST_ID_HEADER = 'x-request-id';
const FALLBACK_HEADER = 'x-correlation-id';
const MAX_LENGTH = 128;

// Valid format: alphanumeric, dot, underscore, hyphen
const VALID_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Validate request ID format or generate a new one.
 */
function validateOrGenerateRequestId(incoming: string | undefined): string {
  if (!incoming) {
    return randomUUID();
  }

  if (incoming.length > MAX_LENGTH) {
    return randomUUID();
  }

  if (!VALID_PATTERN.test(incoming)) {
    return randomUUID();
  }

  return incoming;
}

/**
 * Request ID middleware.
 * - Reads X-Request-ID or X-Correlation-ID header
 * - Validates format (alphanumeric + . _ -, max 128 chars)
 * - Generates UUID if missing/invalid
 * - Sets in AsyncLocalStorage context
 * - Adds X-Request-ID to response headers
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const incoming =
    req.headers[REQUEST_ID_HEADER] as string | undefined ||
    req.headers[FALLBACK_HEADER] as string | undefined;

  const requestId = validateOrGenerateRequestId(incoming);

  // Attach to request for easy access
  (req as Request & { requestId: string }).requestId = requestId;

  // Set response header
  res.setHeader('X-Request-ID', requestId);

  // Run the rest of the request in AsyncLocalStorage context
  runWithRequestContext({ requestId }, () => {
    next();
  });
}

// Extend Express Request type
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}
