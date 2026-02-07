import type { Request, Response, NextFunction } from 'express';
import { trackEvent } from '../../core/analytics.js';

/**
 * Middleware to track API requests in PostHog
 */
export function analyticsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const startTime = Date.now();

  // Track request after response is sent
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const userId = req.user?.id || 'anonymous';

    // Only track in production or if explicitly enabled
    if (process.env.NODE_ENV !== 'production' && !process.env.POSTHOG_TRACK_DEV) {
      return;
    }

    // Skip tracking health checks and docs
    if (req.path === '/health' || req.path.startsWith('/api-docs')) {
      return;
    }

    trackEvent('api_request', userId, {
      method: req.method,
      path: req.path,
      status_code: res.statusCode,
      duration_ms: duration,
      user_agent: req.get('user-agent'),
      ip: req.ip,
    });
  });

  next();
}
