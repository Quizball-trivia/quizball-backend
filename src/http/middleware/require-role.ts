import type { Request, Response, NextFunction } from 'express';
import { AuthorizationError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

/**
 * Middleware to require specific user role(s).
 * Must be used after authMiddleware which attaches req.user.
 *
 * @param allowedRoles - One or more roles that are permitted
 * @returns Express middleware function
 *
 * @example
 * // Require admin role
 * router.post('/', authMiddleware, requireRole('admin'), handler);
 *
 * // Allow multiple roles
 * router.put('/:id', authMiddleware, requireRole('admin', 'editor'), handler);
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const userRole = req.user?.role;

    if (!userRole || !allowedRoles.includes(userRole)) {
      logger.warn(
        {
          userId: req.user?.id,
          userRole: userRole ?? 'none',
          requiredRoles: allowedRoles,
          method: req.method,
          path: req.originalUrl,
        },
        'Role check failed: insufficient permissions'
      );
      throw new AuthorizationError('Insufficient permissions');
    }

    next();
  };
}
