export type PositionGroup = 'GK' | 'DEF' | 'MID' | 'FWD';
export type FormationName = '4-3-3' | '4-4-2' | '3-5-2' | '4-2-3-1' | '3-4-3';

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
  isBot: boolean;
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
  budgetRemaining: number;
  player: AuctionPlayer;
}
