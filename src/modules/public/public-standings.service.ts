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
  status: 'live' | 'not_started' | 'unavailable';
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
    if (!standings.tournament_id || standings.game_index == null) {
      return { competition: 'weekend_league', scoring_label: 'points', status: 'not_started', entries: [], updated_at };
    }
    return {
      competition: 'weekend_league', scoring_label: 'points', status: 'live', updated_at,
      entries: standings.entries.slice(0, TOP).map((e) => ({ alias: e.nickname ?? 'Player', rank: e.rank, score: e.points })),
    };
  } catch (error) {
    logger.warn({ error }, 'public standings: weekend league unavailable');
    return { competition: 'weekend_league', scoring_label: 'points', status: 'unavailable', entries: [], updated_at };
  }
}

export const publicStandingsService = {
  async get(): Promise<{ ranked: PublicStandingsBlock; weekend_league: PublicStandingsBlock }> {
    return getOrLoadJson('public:standings:v1', CACHE_SECONDS, async () => {
      const [r, w] = await Promise.all([ranked(), weekendLeague()]);
      return { ranked: r, weekend_league: w };
    });
  },
};
