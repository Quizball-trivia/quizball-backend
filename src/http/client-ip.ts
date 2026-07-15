import { isIP } from 'node:net';
import type { Request } from 'express';
import { config } from '../core/config.js';
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
  const railwayIp = normalizeClientIp(firstHeaderValue(req.headers['x-real-ip']));
  if (railwayIp) return railwayIp;
  if (nodeEnv !== 'local') return undefined;
  return normalizeClientIp(req.socket?.remoteAddress);
}

export function authRequestContext(req: Pick<Request, 'headers' | 'socket'>): AuthRequestContext | undefined {
  const clientIp = resolveTrustedClientIp(req);
  return clientIp ? { clientIp } : undefined;
}
