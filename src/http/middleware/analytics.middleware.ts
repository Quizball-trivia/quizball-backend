import type { Request, Response, NextFunction } from 'express';
import { trackEvent } from '../../core/analytics.js';

function isApiRequestTrackingEnabled(): boolean {
  const value = process.env.POSTHOG_TRACK_API_REQUESTS ?? process.env.POSTHOG_TRACK_DEV;
  return value?.trim().toLowerCase() === 'true';
}

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
    const userId = req.user?.id;

    // API request analytics are high-volume. Keep them explicit opt-in and never
    // create an "anonymous" PostHog person for unauthenticated traffic.
    if (!isApiRequestTrackingEnabled() || !userId) {
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
