import type { User } from '../db/types.js';
import type { AuthIdentity } from '../core/types.js';

/**
 * Extended Express Request interface.
 * Consolidates all custom request properties.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Authenticated user (set by authMiddleware) */
      user?: User;
      /** Auth identity from token (set by authMiddleware) */
      identity?: AuthIdentity;
      /** Request ID for tracing */
      requestId: string;
      /** Validated request data (set by validate middleware) */
      validated: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
