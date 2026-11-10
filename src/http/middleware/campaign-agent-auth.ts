import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../../core/config.js';
import { AuthenticationError, NotFoundError } from '../../core/errors.js';

/**
 * The quiz-page agent's own credential: a bearer token whose sha256 is set per environment, so a staging token never
 * opens production and rotating the variable revokes it. It reaches only the agent routes, never the admin API.
 */
export function campaignAgentAuth(req: Request, _res: Response, next: NextFunction): void {
  const expected = config.CAMPAIGN_AGENT_TOKEN_SHA256;
  if (!expected || !config.CAMPAIGN_AGENT_USER_ID) {
    next(new NotFoundError('Not found'));
    return;
  }
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const given = createHash('sha256').update(token).digest();
  if (!token || !timingSafeEqual(given, Buffer.from(expected, 'hex'))) {
    next(new AuthenticationError('Invalid agent token'));
    return;
  }
  next();
}

export function campaignAgentUserId(): string {
  if (!config.CAMPAIGN_AGENT_USER_ID) throw new NotFoundError('Not found');
  return config.CAMPAIGN_AGENT_USER_ID;
}
