import { importPKCS8, SignJWT } from 'jose';
import { config } from '../../core/config.js';
import { ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { AdminCampaignQuizSearchConsoleResponse } from './campaign-quizzes.schemas.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEARCH_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API_BASE = 'https://www.googleapis.com/webmasters/v3/sites';

const SPANISH_SOURCE_SLUGS: Record<string, string> = {
  'adivina-el-jugador': 'guess-the-player',
  'trayectoria-del-jugador': 'career-path',
  'escudos-de-futbol': 'club-badges',
  'seleccion-argentina': 'argentina',
  'seleccion-espanola': 'spain',
};

/** Russian public slugs (/ru/futbolnaya-viktorina/<slug>) → CMS slug; mirrors the web's RUSSIAN_PUBLIC_SLUGS. */
const RUSSIAN_SOURCE_SLUGS: Record<string, string> = {
  'ugaday-futbolista': 'guess-the-player',
  'ugaday-futbolista-po-karere': 'career-path',
  'ugaday-klub-po-embleme': 'club-badges',
  'viktorina-apl': 'premier-league',
  'viktorina-arsenal': 'arsenal',
  'viktorina-aston-villa': 'aston-villa',
  'viktorina-barselona': 'barcelona',
  'viktorina-bornmut': 'bournemouth',
  'viktorina-brayton': 'brighton',
  'viktorina-brentford': 'brentford',
  'viktorina-chelsi': 'chelsea',
  'viktorina-everton': 'everton',
  'viktorina-fulkhem': 'fulham',
  'viktorina-ipsvich-taun': 'ipswich-town',
  'viktorina-khall-siti': 'hull-city',
  'viktorina-koventri-siti': 'coventry-city',
  'viktorina-kristal-pelas': 'crystal-palace',
  'viktorina-la-liga': 'la-liga',
  'viktorina-lids-yunayted': 'leeds-united',
  'viktorina-liverpul': 'liverpool',
  'viktorina-manchester-siti': 'manchester-city',
  'viktorina-manchester-yunayted': 'manchester-united',
  'viktorina-nottingem-forest': 'nottingham-forest',
  'viktorina-nyukasl-yunayted': 'newcastle-united',
  'viktorina-real-madrid': 'real-madrid',
  'viktorina-sanderlend': 'sunderland',
  'viktorina-sbornaya-argentiny': 'argentina',
  'viktorina-sbornaya-ispanii': 'spain',
  'viktorina-tottenkhem': 'tottenham',
};

/** Brazilian Portuguese public slugs (/pt/quiz-de-futebol/<slug>) → CMS slug; mirrors the web's PORTUGUESE_PUBLIC_SLUGS. */
const PORTUGUESE_SOURCE_SLUGS: Record<string, string> = {
  'adivinhe-o-jogador': 'guess-the-player',
  'adivinhe-o-jogador-pela-carreira': 'career-path',
  'adivinhe-o-time-pelo-escudo': 'club-badges',
  'quiz-da-premier-league': 'premier-league',
  'quiz-da-la-liga': 'la-liga',
  'quiz-do-arsenal': 'arsenal',
  'quiz-do-aston-villa': 'aston-villa',
  'quiz-do-barcelona': 'barcelona',
  'quiz-do-bournemouth': 'bournemouth',
  'quiz-do-brentford': 'brentford',
  'quiz-do-brighton': 'brighton',
  'quiz-do-chelsea': 'chelsea',
  'quiz-do-coventry-city': 'coventry-city',
  'quiz-do-crystal-palace': 'crystal-palace',
  'quiz-do-everton': 'everton',
  'quiz-do-fulham': 'fulham',
  'quiz-do-hull-city': 'hull-city',
  'quiz-do-ipswich-town': 'ipswich-town',
  'quiz-do-leeds-united': 'leeds-united',
  'quiz-do-liverpool': 'liverpool',
  'quiz-do-manchester-city': 'manchester-city',
  'quiz-do-manchester-united': 'manchester-united',
  'quiz-do-newcastle': 'newcastle-united',
  'quiz-do-nottingham-forest': 'nottingham-forest',
  'quiz-do-real-madrid': 'real-madrid',
  'quiz-do-sunderland': 'sunderland',
  'quiz-do-tottenham': 'tottenham',
  'quiz-da-selecao-argentina': 'argentina',
  'quiz-da-selecao-espanhola': 'spain',
};

let cachedToken: { value: string; expiresAt: number } | null = null;
const cachedMetrics = new Map<
  number,
  { value: AdminCampaignQuizSearchConsoleResponse; expiresAt: number }
>();

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

export function campaignQuizSlugFromPageUrl(
  value: string,
  siteOrigin = config.PUBLIC_SITE_ORIGIN,
): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== new URL(siteOrigin).origin) return null;

    const englishOrGeorgian = url.pathname.match(
      /^\/(?:en|ka)\/football-quiz\/([a-z0-9-]+)\/?$/,
    );
    if (englishOrGeorgian?.[1]) return englishOrGeorgian[1];

    const spanish = url.pathname.match(/^\/es\/quiz-de-futbol\/([a-z0-9-]+)\/?$/);
    if (spanish?.[1]) return SPANISH_SOURCE_SLUGS[spanish[1]] ?? spanish[1];

    const russian = url.pathname.match(/^\/ru\/futbolnaya-viktorina\/([a-z0-9-]+)\/?$/);
    if (russian?.[1]) return RUSSIAN_SOURCE_SLUGS[russian[1]] ?? russian[1];

    const portuguese = url.pathname.match(/^\/pt\/quiz-de-futebol\/([a-z0-9-]+)\/?$/);
    if (!portuguese?.[1]) return null;
    return PORTUGUESE_SOURCE_SLUGS[portuguese[1]] ?? portuguese[1];
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
    const cached = cachedMetrics.get(days);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

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
            filters: [{
              dimension: 'page',
              operator: 'includingRegex',
              expression: '/(football-quiz|quiz-de-futbol)/',
            }],
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
    const positionImpressionsBySlug = new Map<string, number>();
    for (const row of payload?.rows ?? []) {
      const slug = row.keys?.[0] ? campaignQuizSlugFromPageUrl(row.keys[0]) : null;
      if (!slug) continue;
      const previous = bySlug.get(slug);
      const clicks = Number(row.clicks) || 0;
      const impressions = Number(row.impressions) || 0;
      const combinedImpressions = (previous?.impressions ?? 0) + impressions;
      const rowPosition = Number.isFinite(Number(row.position)) ? Number(row.position) : null;
      const previousPositionImpressions = positionImpressionsBySlug.get(slug) ?? 0;
      const positionImpressions = previousPositionImpressions
        + (rowPosition === null ? 0 : impressions);
      const weightedPosition = positionImpressions > 0
        ? (
            ((previous?.position ?? 0) * previousPositionImpressions)
            + ((rowPosition ?? 0) * (rowPosition === null ? 0 : impressions))
          ) / positionImpressions
        : null;
      positionImpressionsBySlug.set(slug, positionImpressions);
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
    cachedMetrics.set(days, { value, expiresAt: Date.now() + 15 * 60_000 });
    return value;
  },
};
