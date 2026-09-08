import { rankedService } from '../ranked/ranked.service.js';
import { weekendLeagueService } from '../weekend-league/weekend-league.service.js';
import { getOrLoadJson } from '../../core/json-cache.js';
import { logger } from '../../core/logger.js';

/**
 * Read-only projection of the real standings for the public homepage. Only
 * approved public fields (alias, rank, score) leave the server; a failure of one
 * competition degrades to an honest status instead of failing the whole response.
 */
export interface PublicStandingEntry { alias: string; rank: number; score: number }
export interface PublicStandingsBlock {
  competition: 'ranked' | 'weekend_league';
  scoring_label: string;
  status: 'live' | 'pending_results' | 'not_started' | 'unavailable';
  entries: PublicStandingEntry[];
  updated_at: string;
}

const CACHE_SECONDS = 120;
const TOP = 5;

async function ranked(): Promise<PublicStandingsBlock> {
  const updated_at = new Date().toISOString();
  try {
    const entries = await rankedService.getLeaderboard(TOP, 0);
    return { competition: 'ranked', scoring_label: 'RP', status: 'live', updated_at, entries: entries.map((e, i) => ({ alias: e.username, rank: i + 1, score: e.rp })) };
  } catch (error) {
    logger.warn({ error }, 'public standings: ranked unavailable');
    return { competition: 'ranked', scoring_label: 'RP', status: 'unavailable', entries: [], updated_at };
  }
}

async function weekendLeague(): Promise<PublicStandingsBlock> {
  const updated_at = new Date().toISOString();
  try {
    const standings = await weekendLeagueService.standings();
    // No current tournament = not started; a tournament with no results yet is live but has nothing to rank.
    if (!standings.tournament_id) return { competition: 'weekend_league', scoring_label: 'points', status: 'not_started', entries: [], updated_at };
    if (standings.game_index == null) return { competition: 'weekend_league', scoring_label: 'points', status: 'pending_results', entries: [], updated_at };
    return {
      competition: 'weekend_league', scoring_label: 'points', status: 'live', updated_at,
      entries: standings.entries.slice(0, TOP).map((e) => ({ alias: e.nickname ?? 'Player', rank: e.rank, score: e.points })),
    };
  } catch (error) {
    logger.warn({ error }, 'public standings: weekend league unavailable');
    return { competition: 'weekend_league', scoring_label: 'points', status: 'unavailable', entries: [], updated_at };
  }
}

type Standings = { ranked: PublicStandingsBlock; weekend_league: PublicStandingsBlock };
/** In-process copy: served while fresh, and as a stale fallback (own timestamps) when Redis or the loaders fail. */
let local: { value: Standings; at: number } | null = null;

export const publicStandingsService = {
  async get(): Promise<Standings> {
    if (local && Date.now() - local.at < CACHE_SECONDS * 1000) return local.value;
    try {
      const value = await getOrLoadJson('public:standings:v1', CACHE_SECONDS, async () => {
        const [r, w] = await Promise.all([ranked(), weekendLeague()]);
        return { ranked: r, weekend_league: w };
      });
      local = { value, at: Date.now() };
      return value;
    } catch (error) {
      logger.warn({ error }, 'public standings: cache/load failed, serving stale copy if any');
      if (local) return local.value;
      const updated_at = new Date().toISOString();
      return { ranked: { competition: 'ranked', scoring_label: 'RP', status: 'unavailable', entries: [], updated_at }, weekend_league: { competition: 'weekend_league', scoring_label: 'points', status: 'unavailable', entries: [], updated_at } };
    }
  },
};
