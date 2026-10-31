import { adminStatsRepo } from './admin-stats.repo.js';
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

async function computeOverview(): Promise<AnalyticsOverviewResponse> {
    const totals = await adminStatsRepo.totals();
    const actives = await adminStatsRepo.actives();
    const dauSeries = await adminStatsRepo.dauSeries(30);
    const signupsPerDay = await adminStatsRepo.signupsPerDay(30);
    const gamesPerDay = await adminStatsRepo.gamesPerDay(30);
    const countries = await adminStatsRepo.countries(10);
    const value: AnalyticsOverviewResponse = {
      totals: {
        registered: totals.registered,
        playingGuests: totals.playing_guests,
        totalUsers: totals.total_users,
        guestConversionPct30d: totals.guests_played_30d > 0
          ? Math.round((totals.guests_converted_30d / totals.guests_played_30d) * 1000) / 10
          : 0,
      },
      actives: { dau: actives.dau, wau: actives.wau, mau: actives.mau },
      dauSeries: dauSeries.map((r) => ({ day: r.day, count: r.count })),
      signupsPerDay: signupsPerDay.map((r) => ({ day: r.day, count: r.count })),
      gamesPerDay: gamesPerDay.map((r) => ({ day: r.day, mode: r.mode, games: r.games })),
      countries: countries.map((r) => ({
        country: r.country, registered: r.registered, guests: r.guests, total: r.total,
      })),
      generatedAt: new Date().toISOString(),
      timezone: 'Asia/Tbilisi',
    };
    cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
}
