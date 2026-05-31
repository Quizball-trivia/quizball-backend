import type { Request } from 'express';
import { logger } from './logger.js';

interface IpApiResponse {
  status: string;
  country: string;
  countryCode: string;
}

type HeaderBag = Record<string, string | string[] | undefined>;

function getHeader(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function firstForwardedIp(value: string | undefined): string | undefined {
  return value?.split(',')[0]?.trim() || undefined;
}

function normalizeIp(ip: string | undefined): string | null {
  const trimmed = ip?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

function resolveClientIp(headers: HeaderBag, fallbackIp: string | null | undefined): string | null {
  return normalizeIp(
    getHeader(headers, 'cf-connecting-ip') ??
    getHeader(headers, 'x-real-ip') ??
    firstForwardedIp(getHeader(headers, 'x-forwarded-for')) ??
    fallbackIp ??
    undefined
  );
}

function isLocalIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

export async function detectCountryFromHeaders(
  headers: HeaderBag,
  ip: string | null | undefined,
): Promise<string | null> {
  // 1. Cloudflare header (instant, no network call)
  const cfCountry = getHeader(headers, 'cf-ipcountry');
  const normalizedCfCountry = typeof cfCountry === 'string' ? cfCountry.toUpperCase() : null;
  if (normalizedCfCountry && normalizedCfCountry.length === 2 && normalizedCfCountry !== 'XX') {
    return normalizedCfCountry;
  }

  // 2. Fallback: ip-api.com
  const clientIp = resolveClientIp(headers, ip);
  if (!clientIp || isLocalIp(clientIp)) {
    // On localhost, try Accept-Language header as last resort (e.g. "en-US,en" → "US")
    const acceptLang = getHeader(headers, 'accept-language');
    if (typeof acceptLang === 'string') {
      const match = acceptLang.match(/[a-z]{2}-([a-z]{2})/i);
      if (match) return match[1]?.toUpperCase() ?? null;
    }
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    // ip-api.com free tier only supports HTTP; HTTPS requires a paid plan
    const res = await fetch(`http://ip-api.com/json/${clientIp}?fields=status,country,countryCode`, {
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const data = (await res.json()) as IpApiResponse;
    if (data.status === 'success' && data.countryCode) {
      return data.countryCode.toUpperCase();
    }
  } catch (err) {
    logger.debug({ err }, 'Geo detection failed — skipping');
  } finally {
    clearTimeout(timeout);
  }

  return null;
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
  return detectCountryFromHeaders(req.headers, req.ip);
}
