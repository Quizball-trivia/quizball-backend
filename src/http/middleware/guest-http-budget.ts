import type { Request, RequestHandler } from 'express';
import { config } from '../../core/config.js';
import { AppError, ErrorCode, RateLimitError } from '../../core/errors.js';
import { getRedisClient } from '../../realtime/redis.js';

export const requireGuestHttpEnabled: RequestHandler = (_req, _res, next) => {
  next(config.GUEST_HTTP_ENABLED ? undefined : new AppError('Guest play is temporarily unavailable', 503));
};

// One counter and expiry operation, shared by all replicas and surviving their
// restarts. If Redis is unavailable, no guest identity or game write proceeds.
const increment = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;

export function guestHttpBudget(
  name: 'mint' | 'standings' | 'ip' | 'principal',
  limit: number,
  subject: (req: Request) => string,
): RequestHandler {
  return async (req, res, next) => {
    const redis = getRedisClient();
    if (!redis?.isOpen) {
      next(new AppError('Guest play is temporarily unavailable', 503, ErrorCode.EXTERNAL_SERVICE_ERROR));
      return;
    }
    const windowSeconds = 3600;
    const now = Date.now();
    const bucket = Math.floor(now / (windowSeconds * 1000));
    const resetSeconds = windowSeconds - Math.floor(now / 1000) % windowSeconds;
    try {
      const count = Number(await redis.eval(increment, {
        keys: [`guest:http:${name}:${subject(req)}:${bucket}`],
        arguments: [String(windowSeconds + 5)],
      }));
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid guest budget response');
      res.setHeader('RateLimit-Limit', String(limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - count)));
      res.setHeader('RateLimit-Reset', String(resetSeconds));
      if (count > limit) {
        res.setHeader('Retry-After', String(resetSeconds));
        next(new RateLimitError());
      } else next();
    } catch {
      next(new AppError('Guest play is temporarily unavailable', 503, ErrorCode.EXTERNAL_SERVICE_ERROR));
    }
  };
}
