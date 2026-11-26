import { logger } from '../../core/logger.js';
import { TABLE_DERBY, addDays, tbilisiDay } from '../partner-stats/partner-days.js';
import { adminStatsRepo, type PartnerDayRow } from './admin-stats.repo.js';
import type { AnalyticsOverviewResponse } from './admin-stats.schemas.js';

const CACHE_TTL_MS = 5 * 60_000;
let cached: { value: AnalyticsOverviewResponse; expiresAt: number } | null = null;
let inflight: Promise<AnalyticsOverviewResponse> | null = null;

/**
 * The real-numbers analytics overview for the CMS. Everything is computed from
 * the production database with the house real-user filter — this surface must
 * never apply demo multipliers (the CMS /stats demo page is a separate,
 * deliberately inflated preview and must not share data paths with this).
 */
export const adminStatsService = {
  async analyticsOverview(): Promise<AnalyticsOverviewResponse> {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    // Single-flight + SEQUENTIAL queries: the first version ran six aggregate
    // queries in parallel, taking half the 12-connection pool per cold-cache
    // request — two simultaneous dashboard tabs starved live traffic (pool
    // queue alert, 2026-10-31 11:30 GE). One connection at a time is plenty
    // for a 5-minute-cached admin page.
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        return await computeOverview();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
};

const SERIES_DAYS = 30;

type DayCount = { day: string; count: number };
type TableDerbyBreakdown = AnalyticsOverviewResponse['breakdown']['tableDerby'];

/** Two day series added by day, oldest first. */
export function addSeries(a: readonly DayCount[], b: readonly DayCount[]): DayCount[] {
  const sum = new Map<string, number>();
  for (const r of [...a, ...b]) sum.set(r.day, (sum.get(r.day) ?? 0) + r.count);
  return [...sum.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([day, count]) => ({ day, count }));
}

/** Table Derby's part: its latest synced day, and its days inside the series window. */
export function tableDerbyBreakdown(rows: readonly PartnerDayRow[], firstDay: string): TableDerbyBreakdown {
  const latest = rows[0];
  if (!latest) return null;
  const inWindow = rows.filter((r) => r.day >= firstDay).reverse();
  return {
    day: latest.day,
    updatedAt: new Date(latest.updated_at).toISOString(),
    totalUsers: latest.total_users,
    newUsers: latest.new_users,
    dau: latest.active_users,
    wau: latest.active_7d,
    mau: latest.active_30d,
    matches: latest.matches,
    dauSeries: inWindow.map((r) => ({ day: r.day, count: r.active_users })),
    signupsPerDay: inWindow.map((r) => ({ day: r.day, count: r.new_users })),
  };
}

async function readTableDerby(firstDay: string): Promise<TableDerbyBreakdown> {
  try {
    return tableDerbyBreakdown(await adminStatsRepo.partnerDays(TABLE_DERBY, SERIES_DAYS), firstDay);
  } catch (error) {
    // Quizball's own numbers never wait on the partner table.
    logger.warn({ error }, 'Partner daily stats unreadable; overview shows Quizball only');
    return null;
  }
}

async function computeOverview(now = new Date()): Promise<AnalyticsOverviewResponse> {
    const totals = await adminStatsRepo.totals();
    const actives = await adminStatsRepo.actives();
    const dauSeries = await adminStatsRepo.dauSeries(SERIES_DAYS);
    const signupsPerDay = await adminStatsRepo.signupsPerDay(SERIES_DAYS);
    const gamesPerDay = await adminStatsRepo.gamesPerDay(SERIES_DAYS);
    const countries = await adminStatsRepo.countries(10);
    const td = await readTableDerby(addDays(tbilisiDay(now), -SERIES_DAYS));
    const quizball = { totalUsers: totals.total_users, dau: actives.dau, wau: actives.wau, mau: actives.mau };
    const quizballDau = dauSeries.map((r) => ({ day: r.day, count: r.count }));
    const quizballSignups = signupsPerDay.map((r) => ({ day: r.day, count: r.count }));
    const value: AnalyticsOverviewResponse = {
      totals: {
        registered: totals.registered,
        playingGuests: totals.playing_guests,
        totalUsers: quizball.totalUsers + (td?.totalUsers ?? 0),
        guestConversionPct30d: totals.guests_played_30d > 0
          ? Math.round((totals.guests_converted_30d / totals.guests_played_30d) * 1000) / 10
          : 0,
      },
      actives: {
        dau: quizball.dau + (td?.dau ?? 0),
        wau: quizball.wau + (td?.wau ?? 0),
        mau: quizball.mau + (td?.mau ?? 0),
      },
      dauSeries: td ? addSeries(quizballDau, td.dauSeries) : quizballDau,
      signupsPerDay: td ? addSeries(quizballSignups, td.signupsPerDay) : quizballSignups,
      gamesPerDay: gamesPerDay.map((r) => ({ day: r.day, mode: r.mode, games: r.games })),
      countries: countries.map((r) => ({
        country: r.country, registered: r.registered, guests: r.guests, total: r.total,
      })),
      breakdown: { quizball, tableDerby: td },
      generatedAt: now.toISOString(),
      timezone: 'Asia/Tbilisi',
    };
    cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
}

export const adminPersonsService = {
  async list(query: import('./admin-stats.schemas.js').PersonsQuery): Promise<import('./admin-stats.schemas.js').PersonsResponse> {
    const { adminPersonsRepo } = await import('./admin-stats.repo.js');
    const search = query.search ?? null;
    const rows = query.kind === 'guest'
      ? await adminPersonsRepo.listGuests(search, query.limit, query.offset)
      : await adminPersonsRepo.listRegistered(search, query.limit, query.offset);
    return {
      persons: rows.map((r) => ({
        id: r.id, kind: r.kind, nickname: r.nickname, email: r.email, country: r.country,
        createdAt: new Date(r.created_at).toISOString(), coins: r.coins, converted: r.converted,
      })),
    };
  },

  async activity(params: import('./admin-stats.schemas.js').PersonParams): Promise<import('./admin-stats.schemas.js').PersonActivityResponse> {
    const { adminPersonsRepo } = await import('./admin-stats.repo.js');
    const rows = params.kind === 'guest'
      ? await adminPersonsRepo.guestActivity(params.id, 200)
      : await adminPersonsRepo.registeredActivity(params.id, 200);
    return {
      activity: rows.map((r) => ({ at: new Date(r.at).toISOString(), type: r.type, meta: r.meta ?? {} })),
    };
  },
};
