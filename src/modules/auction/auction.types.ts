import type { AuctionBotProfile } from '../../realtime/services/auction-bot-profile.js';

export type { AuctionBotProfile };

export type PositionGroup = 'GK' | 'DEF' | 'MID' | 'FWD';
export type FormationName = '2-2-2';

export type PositionNeeds = Record<PositionGroup, number>;

export interface AuctionFormationRow {
  pos: PositionGroup;
  count: number;
}

export interface AuctionFormation {
  name: FormationName;
  required: PositionNeeds;
  rows: readonly AuctionFormationRow[];
}

/**
 * One season of a player's career, served anonymised during bidding as the
 * "scouting snapshot" (replaces text clues when available). Field names match
 * the web client's SeasonSnapshot 1:1.
 */
export interface AuctionSeasonSnapshot {
  season: string;
  league: string;
  age: number | null;
  apps: number;
  goals: number;
  assists?: number;
  cleanSheets?: number;
  conceded?: number;
  valueEur: number;
}

export interface AuctionFootballer {
  id: string;
  clueCardId?: string;
  name: string;
  positionGroup: PositionGroup;
  trueValue: number;
  startingPrice: number;
  clues?: readonly string[];
  imageUrl?: string | null;
  currentClub?: string | null;
  nationality?: string | null;
  /** Competition the player's club plays in — a chemistry dimension. */
  league?: string | null;
  /**
   * Career seasons, chronological. First entry = the anonymised clue season;
   * last entry = the scoring season, whose valueEur is forced equal to
   * trueValue so client-side profit math agrees with the server ranking.
   */
  snapshots?: readonly AuctionSeasonSnapshot[];
}

export type AuctionTeamSlots = Record<PositionGroup, AuctionFootballer[]>;

export interface AuctionTeam {
  formation: AuctionFormation;
  slots: AuctionTeamSlots;
}

export interface AuctionPlayer {
  seatId: string;
  userId?: string | null;
  displayName: string;
  avatarUrl?: string | null;
  /**
   * Real user's layered avatar (passed through to the client as-is for opponent
   * rendering). Null for bots — the client generates a random avatar for those.
   */
  avatarCustomization?: unknown | null;
  /**
   * Ranked identity for the showdown/lineup cards: humans get their real
   * tier + RP; bots get a fabricated-but-stable pair (players must never be
   * able to tell a seat is a bot from its card).
   */
  tier?: string | null;
  rp?: number | null;
  isBot: boolean;
  /**
   * The budget this seat STARTED with. Ranking reconstructs spend from it, so
   * a state created under an older economy (e.g. the €1B era) keeps scoring
   * correctly after a deploy changes STARTING_BUDGET. Absent on legacy states.
   */
  startingBudget?: number;
  /**
   * Bidding personality for a PERSISTENT roster bot, copied onto the seat at
   * seating time so the decision function stays pure and the match's behaviour is
   * pinned for its whole life (a roster refresh mid-match cannot alter it).
   * Absent for humans and for ephemeral bots, which use the legacy heuristic.
   *
   * SERVER-ONLY: stripped by toPublicAuctionMatchState — never sent to clients,
   * which must not be able to tell a bot seat from a human one.
   */
  botProfile?: AuctionBotProfile | null;
  budget: number;
  team: AuctionTeam;
  isEliminated: boolean;
  /**
   * Player quit / disconnect-forfeited out of the match (distinct from honest
   * budget elimination, which also sets isEliminated). Forfeiters always rank
   * below every non-forfeiter and never receive coin rewards.
   */
  forfeited?: boolean;
}

export interface AuctionBidValidationInput {
  amount: number;
  budget: number;
  emptySlots: number;
  startingPrice: number;
  highestBid?: number | null;
}

export interface AuctionPlayerRanking {
  seatId: string;
  userId?: string | null;
  isBot: boolean;
  displayName: string;
  rank: number;
  isComplete: boolean;
  totalTrueValue: number;
  /** Squad chemistry total (0…MAX_SQUAD_CHEMISTRY). */
  chemistry: number;
  /** Squad value minus what was spent (later-season "sell" value − amount paid).
   *  Can be negative. */
  profit: number;
  /** Profit scaled by chemistry — the score players are RANKED on. */
  adjustedProfit: number;
  budgetRemaining: number;
  player: AuctionPlayer;
}
