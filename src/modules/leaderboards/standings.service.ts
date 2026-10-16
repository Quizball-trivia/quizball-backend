import { normalizeSupportedCountryCode } from '../../core/country.js';
import { getOrLoadJson } from '../../core/json-cache.js';
import { standingsRepo, type StandingRow, type StandingsKind, type StandingsMode } from './standings.repo.js';

// Group totals move slowly; one shared copy per mode and kind for everyone.
const STANDINGS_CACHE_TTL_SECONDS = 60;
const TOP_SCORERS = 10;

export interface ViewerStanding {
  /** The viewer's country code or canonical club id. */
  mine: string;
  /** 1–10 when the viewer's points count toward the group's score. */
  slot: number | null;
  /** Points needed to enter the group's top 10, when outside it. */
  gap: number | null;
  /** The viewer's live points in this mode (null before they score). */
  points: number | null;
}

export const standingsService = {
  async list(mode: StandingsMode, kind: StandingsKind): Promise<StandingRow[]> {
    const rows = await getOrLoadJson(`leaderboard:standings:v1:${mode}:${kind}`, STANDINGS_CACHE_TTL_SECONDS, () =>
      standingsRepo.list(mode, kind),
    );
    // Legacy country values have no board to open, so they stay out of the table.
    return kind === 'country' ? rows.filter((row) => normalizeSupportedCountryCode(row.key) === row.key) : rows;
  },

  /** Never cached with the shared rows: it is about one viewer. */
  async viewer(mode: StandingsMode, kind: StandingsKind, mine: string, userId: string): Promise<ViewerStanding> {
    const rows = await standingsRepo.topTenAndViewer(mode, kind, mine, userId);
    const own = rows.find((row) => row.userId === userId);
    const points = own?.points ?? null;
    if (own && own.pos <= TOP_SCORERS) return { mine, slot: own.pos, gap: null, points };
    const tenth = rows.find((row) => row.pos === TOP_SCORERS);
    // Fewer than ten scoring players: any points at all make the top 10.
    if (!tenth) return { mine, slot: null, gap: own ? null : 1, points };
    return { mine, slot: null, gap: Math.max(1, tenth.points - (own?.points ?? 0) + 1), points };
  },
};
