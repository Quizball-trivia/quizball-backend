import { isIP } from 'node:net';
import type { Request } from 'express';
import { config } from '../core/config.js';
import { UTM_ATTRIBUTION_HEADER, parseUtmAttribution } from '../core/utm-attribution.js';
import { CAMPAIGN_ATTRIBUTION_HEADER, parseCampaignAttribution } from '../core/campaign-attribution.js';
import type { AuthRequestContext } from '../modules/auth/auth.client.js';

type HeaderValue = string | string[] | undefined;

function firstHeaderValue(value: HeaderValue): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

/**
 * Normalize one literal IP address. Lists such as X-Forwarded-For are rejected
 * deliberately: callers must select an address only at a trusted proxy edge.
 */
export function normalizeClientIp(value: string | null | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw || raw.includes(',')) return undefined;
  const normalized = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
  return isIP(normalized) === 0 ? undefined : normalized;
}

/**
 * Railway documents X-Real-IP as the client address it supplies at its trusted
 * edge. Never use a caller-controlled X-Forwarded-For value for Supabase Auth
 * forwarding: doing so would let attackers rotate the upstream rate-limit key.
 *
 * Local development has no Railway edge, so the direct socket peer is the only
 * allowed fallback. Outside local, a missing/invalid Railway header means we do
 * not forward an IP and let Supabase fall back to the backend address.
 */
export function resolveTrustedClientIp(
  req: Pick<Request, 'headers' | 'socket'>,
  nodeEnv: 'local' | 'staging' | 'prod' = config.NODE_ENV,
): string | undefined {
  if (nodeEnv === 'local') return normalizeClientIp(req.socket?.remoteAddress);
  return normalizeClientIp(firstHeaderValue(req.headers['x-real-ip']));
}

export function authRequestContext(req: Pick<Request, 'headers' | 'socket'>): AuthRequestContext | undefined {
  const clientIp = resolveTrustedClientIp(req);
  // Signup attribution: the auth ROUTES (login / social / OTP verify) are what
  // actually win the user INSERT for a brand-new account, so the campaign tags
  // have to ride along here — the /users/me middleware only sees an account
  // that already exists.
  const utm = parseUtmAttribution(req.headers[UTM_ATTRIBUTION_HEADER]);
  const campaign = parseCampaignAttribution(req.headers[CAMPAIGN_ATTRIBUTION_HEADER]);
  if (!clientIp && !utm && !campaign) return undefined;
  return {
    ...(clientIp ? { clientIp } : {}),
    ...(utm ? { utm } : {}),
    ...(campaign ? { campaign } : {}),
  };
}
