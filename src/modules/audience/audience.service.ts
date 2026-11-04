import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { posthogSettings, runHogQL, type PosthogSettings } from '../hq/hq.posthog.js';
import { audienceRepo, type DayRange } from './audience.repo.js';
import type { AudiencePeriod, AudienceResponse, AudienceSources } from './audience.schemas.js';

const TZ = 'Asia/Tbilisi';
/** The first day every play table records players completely (full-history game usage audit, 2026-10-25). */
export const COVERAGE_START = '2026-02-05';
const CACHE_TTL_MS = 5 * 60_000;
const POSTHOG_TIMEOUT_MS = 30_000;
// Keyed by period and Georgia date, so a "yesterday" computed before midnight is never served after it.
const cache = new Map<string, { value: AudienceResponse; expiresAt: number }>();
const inflight = new Map<string, Promise<AudienceResponse>>();
let generation = 0;

/** Today's Georgia date as YYYY-MM-DD. */
export function georgiaToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Complete Georgia days, ending yesterday; "today" is the partial current day. */
export function periodRanges(period: AudiencePeriod, today: string): { current: DayRange; previous: DayRange | null } {
  if (period === 'today') return { current: { from: today, to: today }, previous: null };
  const days = period === 'yesterday' ? 1 : period === '7d' ? 7 : 30;
  const to = addDays(today, -1);
  const from = addDays(today, -days);
  return { current: { from, to }, previous: { from: addDays(from, -days), to: addDays(from, -1) } };
}

function settings(): PosthogSettings | null {
  return posthogSettings({ ...config, NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST, POSTHOG_HOST: process.env.POSTHOG_HOST });
}

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const s = (v: unknown, fallback: string) => (v === null || v === undefined || v === '' ? fallback : String(v));

/**
 * Where new visitors came from, per PostHog: people whose first pageview in the last 120 days falls in the range,
 * with the referrer, landing page and UTM source of that first pageview. Works for anonymous visitors too (the web
 * client only creates person profiles for identified users).
 */
async function sources(range: DayRange): Promise<AudienceSources> {
  const ps = settings();
  if (!ps) return { connected: false };
  const firsts = `
    SELECT person_id,
           min(timestamp) AS first_at,
           argMin(coalesce(nullIf(properties.$referring_domain, ''), '$direct'), timestamp) AS referrer,
           argMin(replaceRegexpOne(coalesce(nullIf(properties.$pathname, ''), '/'), '/[0-9a-f-]{36}', '/:id'), timestamp) AS landing,
           argMin(coalesce(nullIf(properties.utm_source, ''), '(none)'), timestamp) AS utm
      FROM events
     WHERE event = '$pageview' AND timestamp >= now() - INTERVAL 120 DAY
       AND coalesce(properties.environment, '') NOT IN ('staging', 'development', 'test', 'local')
       AND (coalesce(properties.$host, '') = '' OR properties.$host IN ('quizball.io', 'www.quizball.io'))
     GROUP BY person_id`;
  const inRange = `toDate(toTimeZone(first_at, '${TZ}')) >= toDate('${range.from}') AND toDate(toTimeZone(first_at, '${TZ}')) <= toDate('${range.to}')`;
  const top = (col: string) => `SELECT ${col} AS k, count() AS people FROM (${firsts}) WHERE ${inRange} GROUP BY k ORDER BY people DESC LIMIT 10`;
  try {
    // PostHog HTTP calls, not database connections, so these can run side by side (~10 s each).
    const [referrers, landing, utm, [visitors]] = await Promise.all([
      runHogQL(ps, top('referrer'), fetch, POSTHOG_TIMEOUT_MS), runHogQL(ps, top('landing'), fetch, POSTHOG_TIMEOUT_MS),
      runHogQL(ps, top('utm'), fetch, POSTHOG_TIMEOUT_MS),
      runHogQL(ps, `SELECT count() FROM (${firsts}) WHERE ${inRange}`, fetch, POSTHOG_TIMEOUT_MS),
    ]);
    const rows = (r: unknown[][]) => r.map(([k, people]) => ({ key: s(k, '(none)'), people: n(people) }));
    return { connected: true, newVisitors: n(visitors?.[0]), referrers: rows(referrers), landingPages: rows(landing), utmSources: rows(utm) };
  } catch (err) {
    logger.warn({ err }, 'Audience: PostHog sources unavailable');
    return { connected: true, error: err instanceof Error ? err.message : 'PostHog query failed' };
  }
}

async function compute(period: AudiencePeriod, today: string, now: Date): Promise<AudienceResponse> {
  const { current, previous } = periodRanges(period, today);
  const yesterday = addDays(today, -1);
  const coverage = await audienceRepo.coverage(COVERAGE_START, yesterday);
  // First-time players can only be told apart once every earlier day is final.
  const historyComplete = coverage.incomplete_days === 0;
  const rangeComplete = period !== 'today' && (await audienceRepo.incompleteDays(current.from, current.to, 1)).length === 0;
  const summary = await audienceRepo.summary(current);
  const newRegistered = await audienceRepo.newRegistered(current);
  const prevSummary = previous ? await audienceRepo.summary(previous) : null;
  const prevNewRegistered = previous ? await audienceRepo.newRegistered(previous) : null;
  const countries = await audienceRepo.countries(current, 15);
  const games = await audienceRepo.games(current, 15);
  const trend = await audienceRepo.trend({ from: addDays(today, -29), to: today });
  const src = await sources(current);
  const cohort = <T>(v: T) => (historyComplete ? v : null);
  return {
    period,
    range: current,
    partial: !rangeComplete,
    summary: {
      active: summary.active, registered: summary.registered, guests: summary.guests, plays: summary.plays,
      newPlayers: cohort(summary.new_players), newGuests: cohort(summary.new_guests), returning: cohort(summary.returning),
      newRegistered: newRegistered.total, newRegisteredPlayed: newRegistered.played,
      signupPlatforms: { web: newRegistered.web, android: newRegistered.android, ios: newRegistered.ios },
    },
    previous: prevSummary && prevNewRegistered && previous ? {
      range: previous, active: prevSummary.active, registered: prevSummary.registered, guests: prevSummary.guests,
      newGuests: cohort(prevSummary.new_guests), newRegistered: prevNewRegistered.total,
    } : null,
    countries: countries.map((c) => ({ country: c.country, active: c.active, registered: c.registered, guests: c.guests, newRegistered: c.new_registered })),
    games: games.map((g) => ({ mode: g.mode, players: g.players, registered: g.registered, guests: g.guests, plays: g.plays })),
    trend,
    sources: src,
    coverage: {
      start: COVERAGE_START, firstCompleteDay: coverage.first_complete_day, incompleteDays: coverage.incomplete_days,
      historyComplete, refreshedAt: coverage.refreshed_at,
    },
    generatedAt: now.toISOString(),
    timezone: TZ,
  };
}

export const audienceService = {
  async get(period: AudiencePeriod, now = new Date()): Promise<AudienceResponse> {
    const today = georgiaToday(now);
    const key = `${period}:${today}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now.getTime()) return hit.value;
    const running = inflight.get(key);
    if (running) return running;
    const startedIn = generation;
    const job = compute(period, today, now)
      .then((value) => {
        if (startedIn === generation) cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        return value;
      })
      .finally(() => { if (inflight.get(key) === job) inflight.delete(key); });
    inflight.set(key, job);
    return job;
  },
  clearCache(): void {
    generation += 1;
    cache.clear();
    inflight.clear();
  },
};
