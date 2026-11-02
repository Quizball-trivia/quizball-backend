import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import type { PosthogAnalytics } from './hq.schemas.js';

// Read-only PostHog client for the HQ analytics page: a handful of HogQL
// queries over the web app's events. The personal API key never leaves this
// module (not in responses, not in logs).

const TIMEOUT_MS = 15_000;
const CACHE_MS = 10 * 60_000;
const TZ = 'Asia/Tbilisi';

// Events the funnel is built from (see src/core/analytics.ts and
// src/core/analytics/game-events.ts — both are kept out of DISABLED_ANALYTICS_EVENTS).
export const FUNNEL_EVENTS = { visit: '$pageview', signup: 'account_created', firstMatch: 'match_started' } as const;

export interface PosthogSettings {
  apiKey: string;
  projectId: string;
  host: string;
}

/** App host for the query API: the ingestion host without ".i." (us.i.posthog.com → us.posthog.com). */
export function deriveApiHost(ingestHost: string | undefined): string {
  const raw = (ingestHost || 'https://us.i.posthog.com').trim().replace(/\/+$/, '');
  return raw.replace(/:\/\/([a-z0-9-]+)\.i\.posthog\.com$/i, '://$1.posthog.com').replace(/:\/\/i\.posthog\.com$/i, '://app.posthog.com');
}

export function posthogSettings(env: {
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;
  POSTHOG_API_HOST?: string;
  POSTHOG_HOST?: string;
  NEXT_PUBLIC_POSTHOG_HOST?: string;
}): PosthogSettings | null {
  if (!env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID) return null;
  const host = (env.POSTHOG_API_HOST?.replace(/\/+$/, '') ||
    deriveApiHost(env.POSTHOG_HOST || env.NEXT_PUBLIC_POSTHOG_HOST));
  return { apiKey: env.POSTHOG_PERSONAL_API_KEY, projectId: env.POSTHOG_PROJECT_ID, host };
}

function queries(days: number) {
  const since = `timestamp >= now() - INTERVAL ${Math.trunc(days)} DAY`;
  const { visit, signup, firstMatch } = FUNNEL_EVENTS;
  return {
    visitorsByDay: `
      SELECT toString(toDate(toTimeZone(timestamp, '${TZ}'))) AS day,
             count(DISTINCT person_id) AS visitors, count() AS pageviews
      FROM events WHERE event = '${visit}' AND ${since}
      GROUP BY day ORDER BY day`,
    topCountries: `
      SELECT coalesce(properties.$geoip_country_code, 'unknown') AS country, count(DISTINCT person_id) AS visitors
      FROM events WHERE event = '${visit}' AND ${since}
      GROUP BY country ORDER BY visitors DESC LIMIT 15`,
    topReferrers: `
      SELECT coalesce(nullIf(properties.$referring_domain, ''), '$direct') AS source, count(DISTINCT person_id) AS visitors
      FROM events WHERE event = '${visit}' AND ${since}
      GROUP BY source ORDER BY visitors DESC LIMIT 15`,
    topPages: `
      SELECT coalesce(properties.$pathname, '/') AS path, count() AS views
      FROM events WHERE event = '${visit}' AND ${since}
      GROUP BY path ORDER BY views DESC LIMIT 15`,
    // Ordered and nested — each step is a subset of the previous one:
    //   visitors   persons with a $pageview in the window
    //   signups    … whose first account_created comes after their first $pageview
    //   firstMatch … who started a match after that signup
    // (min/max of a missing event is the epoch, so absent steps never pass.)
    funnel: `
      SELECT count() AS visitors,
             countIf(signup_at > visit_at) AS signups,
             countIf(signup_at > visit_at AND last_match_at > signup_at) AS first_match
      FROM (
        SELECT person_id,
               minIf(timestamp, event = '${visit}') AS visit_at,
               minIf(timestamp, event = '${signup}') AS signup_at,
               maxIf(timestamp, event = '${firstMatch}') AS last_match_at
        FROM events
        WHERE event IN ('${visit}', '${signup}', '${firstMatch}') AND ${since}
        GROUP BY person_id
        HAVING countIf(event = '${visit}') > 0
      )`,
  };
}

export class PosthogQueryError extends Error {
  constructor(public readonly status: number | null, message: string) {
    super(message);
  }
}

type Fetch = typeof fetch;

async function runHogQL(s: PosthogSettings, query: string, fetchImpl: Fetch): Promise<unknown[][]> {
  let res: Response;
  try {
    res = await fetchImpl(`${s.host}/api/projects/${encodeURIComponent(s.projectId)}/query/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new PosthogQueryError(null, timedOut ? 'PostHog did not answer in time' : 'Could not reach PostHog');
  }
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? 'PostHog rejected the API key (needs query:read on this project)'
        : `PostHog query failed (HTTP ${res.status})`;
    throw new PosthogQueryError(res.status, hint);
  }
  const json = (await res.json()) as { results?: unknown[][] };
  return Array.isArray(json.results) ? json.results : [];
}

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const str = (v: unknown, fallback: string) => (v === null || v === undefined || v === '' ? fallback : String(v));

const cache = new Map<number, { at: number; value: PosthogAnalytics }>();

export function clearPosthogCache(): void {
  cache.clear();
}

export async function fetchPosthogAnalytics(
  days: number,
  opts: { settings?: PosthogSettings | null; fetchImpl?: Fetch; now?: () => number } = {}
): Promise<PosthogAnalytics> {
  const settings =
    opts.settings !== undefined
      ? opts.settings
      : posthogSettings({ ...config, NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST, POSTHOG_HOST: process.env.POSTHOG_HOST });
  if (!settings) return { connected: false };
  const now = opts.now ?? Date.now;
  const hit = cache.get(days);
  if (hit && now() - hit.at < CACHE_MS) return hit.value;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const q = queries(days);
  try {
    const [byDay, countries, referrers, pages, funnel] = await Promise.all([
      runHogQL(settings, q.visitorsByDay, fetchImpl),
      runHogQL(settings, q.topCountries, fetchImpl),
      runHogQL(settings, q.topReferrers, fetchImpl),
      runHogQL(settings, q.topPages, fetchImpl),
      runHogQL(settings, q.funnel, fetchImpl),
    ]);
    const f = funnel[0] ?? [];
    const value: PosthogAnalytics = {
      connected: true,
      visitorsByDay: byDay.map((r) => ({ date: str(r[0], ''), visitors: n(r[1]), pageviews: n(r[2]) })),
      topCountries: countries.map((r) => ({ country: str(r[0], 'unknown'), visitors: n(r[1]) })),
      topReferrers: referrers.map((r) => ({ source: str(r[0], '$direct'), visitors: n(r[1]) })),
      topPages: pages.map((r) => ({ path: str(r[0], '/'), views: n(r[1]) })),
      funnel: { visitors: n(f[0]), signups: n(f[1]), firstMatch: n(f[2]) },
    };
    cache.set(days, { at: now(), value });
    return value;
  } catch (err) {
    const message = err instanceof PosthogQueryError ? err.message : 'PostHog query failed';
    logger.warn({ status: err instanceof PosthogQueryError ? err.status : null, message }, 'hq: posthog analytics failed');
    return { connected: true, error: message };
  }
}
