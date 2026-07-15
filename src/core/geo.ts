import type { Request } from 'express';
import { logger } from './logger.js';

interface IpApiResponse {
  status: string;
  country: string;
  countryCode: string;
}

const GEO_LOOKUP_TIMEOUT_MS = 500;
const GEO_POSITIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GEO_NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const GEO_CACHE_MAX_ENTRIES = 10_000;

interface GeoCacheEntry {
  country: string | null;
  expiresAt: number;
}

const geoCache = new Map<string, GeoCacheEntry>();
const geoLookupsInFlight = new Map<string, Promise<string | null>>();

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

function pruneGeoCache(now: number): void {
  for (const [ip, entry] of geoCache) {
    if (entry.expiresAt <= now) geoCache.delete(ip);
  }
  while (geoCache.size >= GEO_CACHE_MAX_ENTRIES) {
    const oldest = geoCache.keys().next().value as string | undefined;
    if (!oldest) break;
    geoCache.delete(oldest);
  }
}

async function fetchCountryByIp(clientIp: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEO_LOOKUP_TIMEOUT_MS);
  try {
    // ip-api.com free tier only supports HTTP; HTTPS requires a paid plan.
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

async function cachedCountryByIp(clientIp: string): Promise<string | null> {
  const now = Date.now();
  const cached = geoCache.get(clientIp);
  if (cached && cached.expiresAt > now) return cached.country;
  if (cached) geoCache.delete(clientIp);

  const existing = geoLookupsInFlight.get(clientIp);
  if (existing) return existing;

  const lookup = fetchCountryByIp(clientIp)
    .then((country) => {
      if (geoCache.size >= GEO_CACHE_MAX_ENTRIES) pruneGeoCache(Date.now());
      geoCache.set(clientIp, {
        country,
        expiresAt: Date.now() + (country ? GEO_POSITIVE_CACHE_TTL_MS : GEO_NEGATIVE_CACHE_TTL_MS),
      });
      return country;
    })
    .finally(() => {
      geoLookupsInFlight.delete(clientIp);
    });
  geoLookupsInFlight.set(clientIp, lookup);
  return lookup;
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

  // Auth middleware can call this on every authenticated request for users who
  // do not yet have a country. Coalesce concurrent lookups and negative-cache
  // failures so an unavailable third-party geo service cannot pin p95 at its
  // timeout or create an outbound retry storm.
  return cachedCountryByIp(clientIp);
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

export const __geoTestHooks = {
  reset(): void {
    geoCache.clear();
    geoLookupsInFlight.clear();
  },
};
