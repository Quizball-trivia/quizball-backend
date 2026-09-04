export type FootballGridLocale = 'en' | 'ka';
export type FootballGridDifficulty = 'easy' | 'normal' | 'hard';
export type FootballGridOrigin = 'random' | 'challenge' | 'private' | 'public' | 'code';

export type FootballGridSeriesFormat = 'single' | 'bo3';

/** Board difficulty mix for a pairing: 'gentle' = mostly easy (default), 'balanced' = leans normal. */
export type FootballGridDifficultyProfile = 'gentle' | 'balanced';

/** Best-of-N progress, attached to state and completion payloads. */
export interface FootballGridSeriesInfo {
  seriesId: string;
  format: FootballGridSeriesFormat;
  /** 1-based index of the game this state belongs to. */
  gameIndex: number;
  /** Games needed to take the series (2 for bo3). */
  targetWins: number;
  wins: Record<string, number>;
  draws: number;
  /** Set once the series is decided; null while games remain. */
  winnerUserId: string | null;
  finished: boolean;
}

export type FootballGridSeriesAdvance =
  | { kind: 'none' }
  | { kind: 'closed'; seriesId: string; winnerUserId: string | null; alreadyRecorded: boolean }
  | {
      kind: 'continued';
      seriesId: string;
      /** Set when the next game already exists (retry path); otherwise it must be created with pairingToken. */
      nextMatchId: string | null;
      pairingToken: string | null;
      players: Array<{ userId: string; seat: 1 | 2; isBot: boolean }>;
      openerSeat: 1 | 2;
      theme: string;
      origin: FootballGridOrigin;
      lobbyId: string | null;
      rematchIndex: number;
    };
export type FootballGridStatus =
  | 'handoff'
  | 'loading'
  | 'countdown'
  | 'active'
  | 'paused'
  | 'completed'
  | 'forfeited'
  | 'cancelled';

export type FootballGridPhase =
  | 'handoff'
  | 'loading'
  | 'countdown'
  | 'turn'
  | 'paused'
  | 'service_interruption'
  | 'terminal';

export type FootballGridResolutionOutcome =
  | 'correct'
  | 'wrong'
  | 'ambiguous'
  | 'already_used';

export type FootballGridCompletionReason =
  | 'line'
  | 'board_full'
  /** No line is still possible for either player: an automatic draw. */
  | 'board_dead'
  /** One player offered a draw and the other accepted. */
  | 'draw_agreed'
  | 'turn_limit'
  | 'forfeit'
  | 'no_action_timeouts'
  | 'disconnect_timeout'
  | 'loading_no_show'
  | 'simultaneous_disconnect'
  | 'administrative_cancel';

export interface FootballGridCriterionView {
  id: string;
  key: string;
  family: 'club' | 'country' | 'league' | 'manager' | 'teammate' | 'trophy_award' | 'wildcard';
  labelEn: string;
  labelKa: string;
  assetKey: string | null;
  difficulty: FootballGridDifficulty;
}

export interface FootballGridBoardView {
  boardId: string;
  boardVersion: number;
  checksum: string;
  rows: [FootballGridCriterionView, FootballGridCriterionView, FootballGridCriterionView];
  columns: [FootballGridCriterionView, FootballGridCriterionView, FootballGridCriterionView];
}

export interface FootballGridPlayerState {
  userId: string;
  seat: 1 | 2;
  isBot: boolean;
  handoffAcknowledged: boolean;
  ready: boolean;
  noActionTimeouts: number;
  pauseBudgetRemainingMs: number;
  /** A declined draw offer locks the offerer out until this turn number. */
  drawOfferLockedUntilTurn: number;
}

export interface FootballGridDrawOffer {
  byUserId: string;
  /** The turn the offer was made on; it lapses when that turn ends. */
  turnNumber: number;
  offeredAt: string;
}

export interface FootballGridClaimState {
  cellIndex: number;
  footballPlayerId: string;
  displayName?: string;
  imageUrl?: string | null;
  claimantUserId: string;
  turnNumber: number;
}

export interface FootballGridState {
  matchId: string;
  status: FootballGridStatus;
  phase: FootballGridPhase;
  board: FootballGridBoardView;
  players: [FootballGridPlayerState, FootballGridPlayerState];
  openerUserId: string;
  currentPlayerUserId: string | null;
  winnerUserId: string | null;
  turnNumber: number;
  stateVersion: number;
  wrongAnswerVisibility?: boolean;
  claims: FootballGridClaimState[];
  phaseDeadlineAt: string | null;
  turnDeadlineAt: string | null;
  turnRemainingMs: number | null;
  pausedAt: string | null;
  pausedFromPhase?: 'countdown' | 'turn' | null;
  reconnectDeadlineAt: string | null;
  completionReason: FootballGridCompletionReason | null;
  drawOffer: FootballGridDrawOffer | null;
}

export interface FootballGridAliasRecord {
  id: string;
  playerId: string;
  alias: string;
  normalizedAlias: string;
  locale: 'en' | 'ka' | 'translit';
  acceptancePolicy: 'exact' | 'unique_only' | 'safe_typo';
}

export interface FootballGridResolvedAnswer {
  outcome: FootballGridResolutionOutcome;
  playerId: string | null;
  aliasId: string | null;
  normalizedInput: string;
}

export interface FootballGridBoardCandidate {
  boardId: string;
  releaseId: string;
  version: number;
  checksum: string;
  difficulty: FootballGridDifficulty;
  /** League pack; 'european' (default) is the full mix. */
  theme?: string;
  rows: [FootballGridCriterionView, FootballGridCriterionView, FootballGridCriterionView];
  columns: [FootballGridCriterionView, FootballGridCriterionView, FootballGridCriterionView];
  cells: Array<{
    playerIds: string[];
    recognizablePlayerIds: string[];
  }>;
}
