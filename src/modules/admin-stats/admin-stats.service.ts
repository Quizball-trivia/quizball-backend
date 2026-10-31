import { adminStatsRepo } from './admin-stats.repo.js';
import type { AnalyticsOverviewResponse } from './admin-stats.schemas.js';

const CACHE_TTL_MS = 60_000;
let cached: { value: AnalyticsOverviewResponse; expiresAt: number } | null = null;

/**
 * The real-numbers analytics overview for the CMS. Everything is computed from
 * the production database with the house real-user filter — this surface must
 * never apply demo multipliers (the CMS /stats demo page is a separate,
 * deliberately inflated preview and must not share data paths with this).
 */
export const adminStatsService = {
  async analyticsOverview(): Promise<AnalyticsOverviewResponse> {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const [totals, actives, dauSeries, signupsPerDay, gamesPerDay, countries] = await Promise.all([
      adminStatsRepo.totals(),
      adminStatsRepo.actives(),
      adminStatsRepo.dauSeries(30),
      adminStatsRepo.signupsPerDay(30),
      adminStatsRepo.gamesPerDay(30),
      adminStatsRepo.countries(10),
    ]);
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
  },
};
