import { rankedService } from '../ranked/ranked.service.js';
import { auctionLeaderboardService } from '../auction/auction-leaderboard.service.js';
import { footballGridLeaderboardService } from '../football-grid/football-grid-leaderboard.service.js';
import { weekendLeagueService } from '../weekend-league/weekend-league.service.js';
import { getOrLoadJson } from '../../core/json-cache.js';
import { logger } from '../../core/logger.js';

/**
 * Read-only projection of the real boards for signed-out visitors. Only
 * approved public fields (alias, rank, score, tier) leave the server. Each
 * competition is a fixed top-50 snapshot cached 120 s; callers cannot shape
 * the cache key. A failed load serves the last good snapshot (with its own
 * timestamp) instead of caching an empty "unavailable" block.
 */
export const PUBLIC_COMPETITIONS = ['ranked', 'auction', 'grid', 'weekend_league'] as const;
export type PublicCompetition = (typeof PUBLIC_COMPETITIONS)[number];
export const isPublicCompetition = (value: unknown): value is PublicCompetition =>
  typeof value === 'string' && (PUBLIC_COMPETITIONS as readonly string[]).includes(value);

export interface PublicStandingEntry { alias: string; rank: number; score: number; tier?: string }
export interface PublicStandingsBlock {
  competition: PublicCompetition;
  scoring_label: string;
  status: 'live' | 'pending_results' | 'not_started' | 'unavailable';
  entries: PublicStandingEntry[];
  updated_at: string;
}

const CACHE_SECONDS = 120;
const BOARD_SIZE = 50;
const SNIPPET_SIZE = 5;
const LABEL: Record<PublicCompetition, string> = { ranked: 'RP', auction: 'AP', grid: 'TP', weekend_league: 'points' };

const alias = (name: unknown): string => (typeof name === 'string' && name.trim() ? name : 'Player');
const live = (competition: PublicCompetition, entries: PublicStandingEntry[]): PublicStandingsBlock =>
  ({ competition, scoring_label: LABEL[competition], status: 'live', entries: entries.slice(0, BOARD_SIZE), updated_at: new Date().toISOString() });

/** Loaders throw on failure so a bad read is never written to the shared cache. */
const loaders: Record<PublicCompetition, () => Promise<PublicStandingsBlock>> = {
  async ranked() {
    const rows = await rankedService.getLeaderboard(BOARD_SIZE, 0);
    return live('ranked', rows.map((e, i) => ({ alias: alias(e.username), rank: i + 1, score: e.rp, ...(e.tier ? { tier: e.tier } : {}) })));
  },
  async auction() {
    const rows = await auctionLeaderboardService.getLeaderboard(BOARD_SIZE, 0);
    return live('auction', rows.map((e, i) => ({ alias: alias(e.username), rank: i + 1, score: e.auctionPoints, ...(e.tier ? { tier: e.tier } : {}) })));
  },
  async grid() {
    const rows = await footballGridLeaderboardService.getLeaderboard(BOARD_SIZE, 0);
    return live('grid', rows.map((e, i) => ({ alias: alias(e.username), rank: i + 1, score: e.ticTacToePoints, ...(e.tier ? { tier: e.tier } : {}) })));
  },
  async weekend_league() {
    const standings = await weekendLeagueService.standings();
    const updated_at = new Date().toISOString();
    // No current tournament = not started; a tournament with no results yet is live but has nothing to rank.
    if (!standings.tournament_id) return { competition: 'weekend_league', scoring_label: LABEL.weekend_league, status: 'not_started', entries: [], updated_at };
    if (standings.game_index == null) return { competition: 'weekend_league', scoring_label: LABEL.weekend_league, status: 'pending_results', entries: [], updated_at };
    return live('weekend_league', standings.entries.slice(0, BOARD_SIZE).map((e) => ({ alias: alias(e.nickname), rank: e.rank, score: e.points })));
  },
};

/** Last successful block per competition, served (with its original timestamp) when a reload fails. */
const lastGood = new Map<PublicCompetition, { value: PublicStandingsBlock; at: number }>();
/** After a failed load, no reload is attempted before this time: public traffic must not amplify an outage. */
const retryAfter = new Map<PublicCompetition, number>();
const RETRY_SECONDS = 15;

async function board(competition: PublicCompetition): Promise<PublicStandingsBlock> {
  const cached = lastGood.get(competition);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_SECONDS * 1000) return cached.value;
  const unavailable = (): PublicStandingsBlock => cached?.value ?? { competition, scoring_label: LABEL[competition], status: 'unavailable', entries: [], updated_at: new Date().toISOString() };
  if ((retryAfter.get(competition) ?? 0) > now) return unavailable();
  try {
    const value = await getOrLoadJson(`public:leaderboard:v1:${competition}`, CACHE_SECONDS, loaders[competition]);
    lastGood.set(competition, { value, at: Date.now() });
    retryAfter.delete(competition);
    return value;
  } catch (error) {
    logger.warn({ error, competition }, 'public standings: load failed, serving last good snapshot if any');
    retryAfter.set(competition, Date.now() + RETRY_SECONDS * 1000);
    return unavailable();
  }
}

const slice = (block: PublicStandingsBlock, size: number): PublicStandingsBlock => ({ ...block, entries: block.entries.slice(0, size) });

export const publicStandingsService = {
  /** Hub snippet: top 5 of ranked + Weekend League. */
  async get(): Promise<{ ranked: PublicStandingsBlock; weekend_league: PublicStandingsBlock }> {
    const [r, w] = await Promise.all([board('ranked'), board('weekend_league')]);
    return { ranked: slice(r, SNIPPET_SIZE), weekend_league: slice(w, SNIPPET_SIZE) };
  },
  /** Read-only public board: fixed top 50 of one competition. */
  board,
};
