import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../../core/config.js';
import { getOnlineCount, recordPing } from '../../realtime/presence-ping.service.js';

const PRESENCE_COOKIE = 'qb_presence_id';
const PRESENCE_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const PRESENCE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.NODE_ENV === 'prod',
  sameSite: (config.NODE_ENV === 'prod' ? 'none' : 'lax') as 'none' | 'lax',
  maxAge: PRESENCE_COOKIE_MAX_AGE_MS,
  path: '/',
};

/**
 * Resolve the presence member for this request. The site-wide counter only needs
 * to count distinct visitors, not identify them — so we key off an anonymous
 * first-party cookie (one browser = one count, logged-in or not). This keeps the
 * heartbeat truly cheap: NO token verification (which, with JWKS unset, would hit
 * Supabase's introspection endpoint every 30s) and no DB/geo work.
 */
function resolvePresenceMember(req: Request, res: Response): string {
  let anonId = typeof req.cookies?.[PRESENCE_COOKIE] === 'string' ? req.cookies[PRESENCE_COOKIE] : undefined;
  if (!anonId) {
    anonId = randomUUID();
    res.cookie(PRESENCE_COOKIE, anonId, PRESENCE_COOKIE_OPTIONS);
  }
  return `anon:${anonId}`;
}

export const presenceController = {
  async ping(req: Request, res: Response): Promise<void> {
    const nowMs = Date.now();
    await recordPing(resolvePresenceMember(req, res), nowMs);
    const online = await getOnlineCount(nowMs);
    res.json({ online });
  },

  async online(_req: Request, res: Response): Promise<void> {
    const online = await getOnlineCount(Date.now());
    res.json({ online });
  },
};
