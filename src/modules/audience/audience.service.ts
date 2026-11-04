import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { posthogSettings, runHogQL, type PosthogSettings } from '../hq/hq.posthog.js';
import { audienceRepo, type DayRange } from './audience.repo.js';
import type { AudiencePeriod, AudienceResponse, AudienceSources } from './audience.schemas.js';

const TZ = 'Asia/Tbilisi';
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<AudiencePeriod, { value: AudienceResponse; expiresAt: number }>();
const inflight = new Map<AudiencePeriod, Promise<AudienceResponse>>();

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

/** Where new people came from, per PostHog: first referring domain, landing page and UTM source of people first seen in the range. */
async function sources(range: DayRange): Promise<AudienceSources> {
  const ps = settings();
  if (!ps) return { connected: false };
  const window = `toDate(toTimeZone(person.created_at, '${TZ}')) >= toDate('${range.from}')
    AND toDate(toTimeZone(person.created_at, '${TZ}')) <= toDate('${range.to}')
    AND toDate(toTimeZone(timestamp, '${TZ}')) >= toDate('${range.from}')
    AND toDate(toTimeZone(timestamp, '${TZ}')) <= toDate('${range.to}')
    AND event = '$pageview' AND coalesce(properties.environment, '') NOT IN ('staging', 'development', 'test', 'local')`;
  const top = (expr: string) => `SELECT ${expr} AS k, count(DISTINCT person_id) AS people FROM events WHERE ${window} GROUP BY k ORDER BY people DESC LIMIT 10`;
  try {
    const referrers = await runHogQL(ps, top(`coalesce(nullIf(person.properties.$initial_referring_domain, ''), '$direct')`));
    const landing = await runHogQL(ps, top(`replaceRegexpOne(coalesce(nullIf(person.properties.$initial_pathname, ''), '/'), '/[0-9a-f-]{36}', '/:id')`));
    const utm = await runHogQL(ps, top(`coalesce(nullIf(person.properties.$initial_utm_source, ''), '(none)')`));
    const [visitors] = await runHogQL(ps, `SELECT count(DISTINCT person_id) FROM events WHERE ${window}`);
    const rows = (r: unknown[][]) => r.map(([k, people]) => ({ key: s(k, '(none)'), people: n(people) }));
    return { connected: true, newVisitors: n(visitors?.[0]), referrers: rows(referrers), landingPages: rows(landing), utmSources: rows(utm) };
  } catch (err) {
    logger.warn({ err }, 'Audience: PostHog sources unavailable');
    return { connected: true, error: err instanceof Error ? err.message : 'PostHog query failed' };
  }
}

async function compute(period: AudiencePeriod, now: Date): Promise<AudienceResponse> {
  const today = georgiaToday(now);
  const { current, previous } = periodRanges(period, today);
  const summary = await audienceRepo.summary(current);
  const newRegistered = await audienceRepo.newRegistered(current);
  const prevSummary = previous ? await audienceRepo.summary(previous) : null;
  const prevNewRegistered = previous ? await audienceRepo.newRegistered(previous) : null;
  const countries = await audienceRepo.countries(current, 15);
  const games = await audienceRepo.games(current, 15);
  const trend = await audienceRepo.trend({ from: addDays(today, -30), to: today });
  const coverage = await audienceRepo.coverage();
  const src = await sources(current);
  return {
    period,
    range: current,
    partial: period === 'today',
    summary: {
      active: summary.active, registered: summary.registered, guests: summary.guests, plays: summary.plays,
      newPlayers: summary.new_players, newGuests: summary.new_guests, returning: summary.returning,
      newRegistered: newRegistered.total, newRegisteredPlayed: newRegistered.played,
      signupPlatforms: { web: newRegistered.web, android: newRegistered.android, ios: newRegistered.ios },
    },
    previous: prevSummary && prevNewRegistered && previous ? {
      range: previous, active: prevSummary.active, registered: prevSummary.registered, guests: prevSummary.guests,
      newGuests: prevSummary.new_guests, newRegistered: prevNewRegistered.total,
    } : null,
    countries: countries.map((c) => ({ country: c.country, active: c.active, registered: c.registered, guests: c.guests, newRegistered: c.new_registered })),
    games: games.map((g) => ({ mode: g.mode, players: g.players, registered: g.registered, guests: g.guests, plays: g.plays })),
    trend,
    sources: src,
    coverage: { firstDay: coverage.first_day, lastDay: coverage.last_day, refreshedAt: coverage.refreshed_at },
    generatedAt: now.toISOString(),
    timezone: TZ,
  };
}

export const audienceService = {
  async get(period: AudiencePeriod, now = new Date()): Promise<AudienceResponse> {
    const hit = cache.get(period);
    if (hit && hit.expiresAt > now.getTime()) return hit.value;
    const running = inflight.get(period);
    if (running) return running;
    const job = compute(period, now)
      .then((value) => {
        cache.set(period, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        return value;
      })
      .finally(() => inflight.delete(period));
    inflight.set(period, job);
    return job;
  },
  clearCache(): void {
    cache.clear();
  },
};
