export type FootballGridLocale = 'en' | 'ka';
export type FootballGridDifficulty = 'easy' | 'normal' | 'hard';
export type FootballGridOrigin = 'random' | 'challenge' | 'private' | 'public' | 'code';
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
  rows: [FootballGridCriterionView, FootballGridCriterionView, FootballGridCriterionView];
  columns: [FootballGridCriterionView, FootballGridCriterionView, FootballGridCriterionView];
  cells: Array<{
    playerIds: string[];
    recognizablePlayerIds: string[];
  }>;
}
