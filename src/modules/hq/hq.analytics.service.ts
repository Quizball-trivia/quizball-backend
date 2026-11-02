import { logger } from '../../core/logger.js';
import { adminStatsRepo, type GamesPerDayRow } from '../admin-stats/admin-stats.repo.js';
import { hqGoalsRepo, type AnalyticsSnapshotRow, type RetentionCohortRow } from './hq.goals.repo.js';
import { fetchPosthogAnalytics } from './hq.posthog.js';
import type { Analytics, PosthogAnalytics } from './hq.schemas.js';

// Company analytics for the HQ page. Player activity and games come from the
// admin-stats queries (every play surface, guests included — the same numbers
// as the CMS Analytics page); signups, countries and registered totals from
// hq.analytics_snapshot; retention from hq.retention_cohorts.

/** Friendly names for the game keys admin-stats buckets games into. */
export const MODE_LABELS: Record<string, string> = {
  ranked: 'Ranked',
  friendly: 'Friendly',
  grid: 'Football Grid',
  party_quiz: 'Party Quiz',
  auction: 'Auction',
  daily: 'Daily games',
  squad_spin: 'Squad Spin',
  trivia_mines: 'Trivia Mines',
  free_kicks: 'Free Kicks',
  road_to_goal: 'Road to Goal',
  guess_the_goal: 'Guess the Goal',
  weekend_league: 'Weekend League',
  duel: 'Duels',
  other: 'Other',
};

const TOP_MODES = 6;
const TOP_COUNTRIES = 30;
const CACHE_MS = 5 * 60_000;
const STALE_MS = 30 * 60_000;
export const RETENTION_WEEKS = 16;

const round3 = (v: number | string | null) => (v === null || v === undefined ? null : Math.round(Number(v) * 1000) / 1000);

/** Pure shaping of the four sources into the API payload (exported for tests). */
export function buildAnalytics(input: {
  days: number;
  snapshot: AnalyticsSnapshotRow;
  games: GamesPerDayRow[];
  retention: RetentionCohortRow[];
}): Analytics {
  const { snapshot } = input;
  const dates = snapshot.series.map((d) => d.date); // zero-filled, oldest first, ends today (Tbilisi)
  // Active players incl. guests (admin-stats identities), from the rollup.
  const actives = snapshot.actives_all ?? snapshot.actives;
  const inRange = input.games.filter((g) => g.day >= dates[0] && g.day <= dates[dates.length - 1]);

  const gamesByDay = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const g of inRange) {
    gamesByDay.set(g.day, (gamesByDay.get(g.day) ?? 0) + Number(g.games));
    totals.set(g.mode, (totals.get(g.mode) ?? 0) + Number(g.games));
  }
  const allGames = [...totals.values()].reduce((a, b) => a + b, 0);
  const modes = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([mode, matches]) => ({ mode, matches, share: allGames ? Math.round((matches / allGames) * 1000) / 1000 : 0 }));

  const top = modes.slice(0, TOP_MODES).map((m) => m.mode);
  const hasOther = modes.length > TOP_MODES;
  const modesByDay = dates.map((date) => {
    const row: { date: string } & Record<string, number | string> = { date };
    for (const m of top) row[m] = 0;
    if (hasOther) row.other = 0;
    for (const g of inRange) {
      if (g.day !== date) continue;
      const key = top.includes(g.mode) ? g.mode : 'other';
      row[key] = Number(row[key] ?? 0) + Number(g.games);
    }
    return row;
  });

  const countries = snapshot.countries
    .map((c) => ({ country: c.country, players: Number(c.players), registered: Number(c.registered) }))
    .sort((a, b) => b.players - a.players || b.registered - a.registered || a.country.localeCompare(b.country));

  const modeLabels: Record<string, string> = {};
  for (const m of modes) modeLabels[m.mode] = MODE_LABELS[m.mode] ?? m.mode.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  if (hasOther) modeLabels.other = MODE_LABELS.other;

  return {
    generatedAt: new Date(snapshot.generated_at).toISOString(),
    days: input.days,
    series: snapshot.series.map((d) => ({
      date: d.date,
      newUsers: Number(d.new_users),
      activePlayers: Number(d.active_all ?? d.active_players),
      matches: gamesByDay.get(d.date) ?? 0,
    })),
    actives: { dau: Number(actives.dau), wau: Number(actives.wau), mau: Number(actives.mau) },
    totals: { registeredUsers: Number(snapshot.total_registered_users) },
    modes,
    modesByDay,
    modeLabels,
    countries: countries.slice(0, TOP_COUNTRIES),
    // Totals over every country (before the top-N cut), for correct shares.
    countriesTotalPlayers: countries.reduce((sum, c) => sum + c.players, 0),
    countriesTotalRegistered: countries.reduce((sum, c) => sum + c.registered, 0),
    retention: input.retention.map((c) => ({
      cohortStart: c.cohort_start,
      size: Number(c.size),
      d1: round3(c.d1),
      d7: round3(c.d7),
      d30: round3(c.d30),
    })),
  };
}

const cache = new Map<number, { at: number; value: Analytics }>();
const inflight = new Map<number, Promise<Analytics>>();

async function computeAnalytics(days: number): Promise<Analytics> {
  // SEQUENTIAL on purpose (same lesson as adminStatsService.analyticsOverview):
  // never fan heavy aggregates out over the per-replica pool. The snapshot and
  // retention read the hq.activity_days rollup (refreshed incrementally inside
  // the functions), so only games-per-mode still touches raw play tables —
  // through created_at indexes.
  const snapshot = await hqGoalsRepo.analyticsSnapshot(days);
  const games = await adminStatsRepo.gamesPerDay(days);
  // D30 needs cohort_start + 6 + 59 days to elapse (~10 weeks), so 16
  // weekly cohorts always include ~6 with a mature D30.
  const retention = await hqGoalsRepo.retentionCohorts(RETENTION_WEEKS);
  return buildAnalytics({ days, snapshot, games, retention });
}

function recompute(days: number, now: () => number): Promise<Analytics> {
  // Single-flight: concurrent requests for the same window share one computation.
  const running = inflight.get(days);
  if (running) return running;
  const p = computeAnalytics(days)
    .then((value) => {
      cache.set(days, { at: now(), value });
      return value;
    })
    .finally(() => inflight.delete(days));
  inflight.set(days, p);
  return p;
}

export const hqAnalyticsService = {
  /**
   * Fresh for 5 minutes; then stale-while-revalidate for up to 30 minutes
   * (the stale copy is returned at once and a background recompute starts).
   */
  async analytics(days: number, now: () => number = Date.now): Promise<Analytics> {
    const hit = cache.get(days);
    const age = hit ? now() - hit.at : Infinity;
    if (hit && age < CACHE_MS) return hit.value;
    if (hit && age < STALE_MS) {
      recompute(days, now).catch((err) => logger.warn({ err, days }, 'hq: analytics background refresh failed'));
      return hit.value;
    }
    return recompute(days, now);
  },

  posthog(days: number): Promise<PosthogAnalytics> {
    return fetchPosthogAnalytics(days);
  },

  clearCache(): void {
    cache.clear();
    inflight.clear();
  },
};
