import { importPKCS8, SignJWT } from 'jose';
import { config } from '../../core/config.js';
import { ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { AdminCampaignQuizSearchConsoleResponse } from './campaign-quizzes.schemas.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEARCH_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API_BASE = 'https://www.googleapis.com/webmasters/v3/sites';
const PRODUCTION_ORIGIN = 'https://quizball.io';

let cachedToken: { value: string; expiresAt: number } | null = null;
let cachedMetrics: { value: AdminCampaignQuizSearchConsoleResponse; expiresAt: number } | null = null;

function configured(): boolean {
  return Boolean(
    config.GOOGLE_SEARCH_CONSOLE_SITE_URL
    && config.GOOGLE_SEARCH_CONSOLE_SERVICE_ACCOUNT_EMAIL
    && config.GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY,
  );
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateRange(days: number): { start: string; end: string } {
  // Search Console data is normally delayed. Ending three days ago avoids
  // presenting incomplete recent rows as a real traffic drop.
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 3);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { start: isoDate(start), end: isoDate(end) };
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const email = config.GOOGLE_SEARCH_CONSOLE_SERVICE_ACCOUNT_EMAIL!;
  const key = await importPKCS8(
    config.GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
    'RS256',
  );
  const assertion = await new SignJWT({ scope: SEARCH_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(email)
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  } | null;
  if (!response.ok || !payload?.access_token) {
    logger.error({ status: response.status, payload }, 'Search Console authentication failed');
    throw new ExternalServiceError('Search Console authentication failed');
  }

  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3_600) * 1_000,
  };
  return cachedToken.value;
}

function slugFromPageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== PRODUCTION_ORIGIN) return null;
    const match = url.pathname.match(/^\/(?:en|ka)\/football-quiz\/([a-z0-9-]+)\/?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export const campaignQuizSearchConsoleService = {
  async metrics(days = 28): Promise<AdminCampaignQuizSearchConsoleResponse> {
    if (!configured()) {
      return {
        configured: false,
        reason: 'Search Console is not connected in this environment.',
        property: config.GOOGLE_SEARCH_CONSOLE_SITE_URL ?? null,
        start_date: null,
        end_date: null,
        pages: [],
      };
    }
    if (cachedMetrics && cachedMetrics.expiresAt > Date.now()) return cachedMetrics.value;

    const range = dateRange(days);
    const property = config.GOOGLE_SEARCH_CONSOLE_SITE_URL!;
    const response = await fetch(
      `${API_BASE}/${encodeURIComponent(property)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate: range.start,
          endDate: range.end,
          type: 'web',
          dimensions: ['page'],
          dimensionFilterGroups: [{
            filters: [{ dimension: 'page', operator: 'contains', expression: '/football-quiz/' }],
          }],
          rowLimit: 25_000,
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const payload = await response.json().catch(() => null) as {
      rows?: Array<{
        keys?: string[];
        clicks?: number;
        impressions?: number;
        ctr?: number;
        position?: number;
      }>;
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      logger.error({ status: response.status, payload }, 'Search Console query failed');
      throw new ExternalServiceError(payload?.error?.message ?? 'Search Console query failed');
    }

    const bySlug = new Map<string, AdminCampaignQuizSearchConsoleResponse['pages'][number]>();
    for (const row of payload?.rows ?? []) {
      const slug = row.keys?.[0] ? slugFromPageUrl(row.keys[0]) : null;
      if (!slug) continue;
      const previous = bySlug.get(slug);
      const clicks = Number(row.clicks) || 0;
      const impressions = Number(row.impressions) || 0;
      const combinedImpressions = (previous?.impressions ?? 0) + impressions;
      const rowPosition = Number.isFinite(Number(row.position)) ? Number(row.position) : null;
      const weightedPosition = combinedImpressions > 0
        ? (
            ((previous?.position ?? 0) * (previous?.impressions ?? 0))
            + ((rowPosition ?? 0) * impressions)
          ) / combinedImpressions
        : rowPosition;
      bySlug.set(slug, {
        slug,
        clicks: (previous?.clicks ?? 0) + clicks,
        impressions: combinedImpressions,
        ctr: combinedImpressions > 0
          ? ((previous?.clicks ?? 0) + clicks) / combinedImpressions
          : 0,
        position: weightedPosition,
      });
    }

    const value: AdminCampaignQuizSearchConsoleResponse = {
      configured: true,
      reason: null,
      property,
      start_date: range.start,
      end_date: range.end,
      pages: [...bySlug.values()].sort((left, right) => right.clicks - left.clicks),
    };
    cachedMetrics = { value, expiresAt: Date.now() + 15 * 60_000 };
    return value;
  },
};
