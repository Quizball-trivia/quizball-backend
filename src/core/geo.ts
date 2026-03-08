import type { Request } from 'express';
import { logger } from './logger.js';

interface IpApiResponse {
  status: string;
  country: string;
  countryCode: string;
}

/**
 * Detect country code from request IP.
 *
 * Priority:
 * 1. CF-IPCountry header (Cloudflare)
 * 2. ip-api.com free lookup (non-commercial, no key needed)
 *
 * Returns ISO 3166-1 alpha-2 code (e.g. "GE", "US") or null on failure.
 */
export async function detectCountryFromRequest(req: Request): Promise<string | null> {
  // 1. Cloudflare header (instant, no network call)
  const cfCountry = req.headers['cf-ipcountry'];
  if (typeof cfCountry === 'string' && cfCountry.length === 2 && cfCountry !== 'XX') {
    return cfCountry.toUpperCase();
  }

  // 2. Fallback: ip-api.com
  const ip = req.ip;
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const data = (await res.json()) as IpApiResponse;
    if (data.status === 'success' && data.countryCode) {
      return data.countryCode.toUpperCase();
    }
  } catch (err) {
    logger.debug({ ip, err }, 'Geo detection failed — skipping');
  }

  return null;
}
