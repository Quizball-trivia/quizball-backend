export type MatchMode = 'friendly' | 'ranked';
export type LobbyGameMode = 'friendly' | 'ranked_sim';
export type LobbyStatus = 'waiting' | 'active' | 'closed';
export type MatchPhase = 'NORMAL_PLAY' | 'SHOT_ON_GOAL' | 'HALFTIME' | 'PENALTY_SHOOTOUT' | 'COMPLETED';
export type MatchPhaseKind = 'normal' | 'shot' | 'penalty';
export type TacticalCard = 'press-high' | 'play-safe' | 'all-in';

export type GameStage =
  | 'idle'
  | 'matchmaking'
  | 'categoryBlocking'
  | 'showdown'
  | 'roundIntro'
  | 'playing'
  | 'roundResult'
  | 'roundTransition'
  | 'finalResults';

export interface LobbyMember {
  userId: string;
  username: string;
  avatarUrl: string | null;
  isReady: boolean;
  isHost: boolean;
}

export interface LobbyState {
  lobbyId: string;
  mode: MatchMode;
  status: LobbyStatus;
  inviteCode: string | null;
  displayName: string;
  isPublic: boolean;
  hostUserId: string;
  settings: LobbySettings;
  members: LobbyMember[];
}

export interface LobbySettings {
  gameMode: LobbyGameMode;
  friendlyRandom: boolean;
  friendlyCategoryAId: string | null;
  friendlyCategoryBId: string | null;
}

export interface DraftCategory {
  id: string;
  name: string;
  icon: string | null;
}

export interface DraftState {
  lobbyId: string;
  categories: DraftCategory[];
  turnUserId: string;
}

export interface OpponentInfo {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export interface GameQuestionDTO {
  id: string;
  prompt: Record<string, string>;
  options: Array<Record<string, string>>;
  categoryId?: string;
  categoryName?: Record<string, string>;
  difficulty?: string;
  explanation?: string | null;
}

export interface MatchStartPayload {
  matchId: string;
  mySeat?: 1 | 2;
  opponent: OpponentInfo;
}

export interface MatchCountdownPayload {
  matchId: string;
  seconds: number;
  startsAt: string;
}

export interface MatchQuestionPayload {
  matchId: string;
  qIndex: number;
  total: number;
  question: GameQuestionDTO;
  deadlineAt: string;
  correctIndex: number;
  phaseKind?: MatchPhaseKind;
  phaseRound?: number | null;
  shooterSeat?: 1 | 2 | null;
  attackerSeat?: 1 | 2 | null;
}

export interface MatchOpponentAnsweredPayload {
  matchId: string;
  qIndex: number;
  opponentTotalPoints: number;
  pointsEarned: number;
  isCorrect: boolean;
  selectedIndex: number | null;
}

export interface MatchAnswerAckPayload {
  matchId: string;
  qIndex: number;
  selectedIndex: number | null;
  isCorrect: boolean;
  correctIndex: number;
  myTotalPoints: number;
  oppAnswered: boolean;
  pointsEarned: number;
  phaseKind?: MatchPhaseKind;
  phaseRound?: number | null;
  shooterSeat?: 1 | 2 | null;
}

export interface MatchRoundResultPlayer {
  selectedIndex: number | null;
  isCorrect: boolean;
  timeMs: number;
  pointsEarned: number;
  totalPoints: number;
}

export interface MatchRoundResultDeltas {
  possessionDelta: number;
  momentumSeat1Delta: number;
  momentumSeat2Delta: number;
  shotOutcome: 'goal' | 'saved' | 'miss' | null;
  penaltyOutcome: 'goal' | 'saved' | null;
  goalScoredBySeat: 1 | 2 | null;
}

export interface MatchRoundResultPayload {
  matchId: string;
  qIndex: number;
  correctIndex: number;
  players: Record<string, MatchRoundResultPlayer>;
  phaseKind?: MatchPhaseKind;
  phaseRound?: number | null;
  shooterSeat?: 1 | 2 | null;
  attackerSeat?: 1 | 2 | null;
  deltas?: MatchRoundResultDeltas;
}

export interface MatchFinalResultPlayer {
  totalPoints: number;
  correctAnswers: number;
  avgTimeMs: number | null;
  goals?: number;
  penaltyGoals?: number;
}

export interface MatchFinalResultsPayload {
  matchId: string;
  winnerId: string | null;
  players: Record<string, MatchFinalResultPlayer>;
  durationMs: number;
  resultVersion: number;
  winnerDecisionMethod?: 'goals' | 'penalty_goals' | 'total_points_fallback' | 'forfeit' | null;
  totalPointsFallbackUsed?: boolean;
}

export interface MatchStatePayload {
  matchId: string;
  phase: MatchPhase;
  half: 1 | 2;
  sharedPossession: number;
  normalQuestionsAnsweredInHalf: number;
  seatMomentum: {
    seat1: number;
    seat2: number;
  };
  attackerSeat: 1 | 2 | null;
  kickOffSeat: 1 | 2;
  goals: {
    seat1: number;
    seat2: number;
  };
  penaltyGoals: {
    seat1: number;
    seat2: number;
  };
  phaseKind: MatchPhaseKind;
  phaseRound: number;
  shooterSeat: 1 | 2 | null;
  halftimeReady: {
    seat1: boolean;
    seat2: boolean;
  };
  stateVersion?: number;
}

export interface MatchOpponentDisconnectedPayload {
  matchId: string;
  opponentId: string;
  graceMs: number;
}

export interface MatchResumePayload {
  matchId: string;
  nextQIndex: number;
}

export interface MatchRejoinAvailablePayload {
  matchId: string;
  mode: MatchMode;
  opponent: OpponentInfo;
  graceMs: number;
}

export interface RankedSearchStartedPayload {
  durationMs: number;
}

export interface RankedMatchFoundPayload {
  lobbyId: string;
  opponent: OpponentInfo;
}

export interface RankedQueueJoinPayload {
  searchMode?: 'human_first';
}

export interface WarmupTapPayload {
  tapX: number;
  tapY: number;
  tapSeq: number;
}

export interface WarmupDroppedPayload {
  clientTs: number;
  y: number;
}

export interface WarmupStatePayload {
  active: boolean;
  bounceCount: number;
  nextTurnUserId: string;
  lastTapperId: string | null;
  startedAt: number;
}

export interface WarmupTappedPayload {
  tapperId: string;
  tapX: number;
  tapY: number;
  bounceCount: number;
  nextTurnUserId: string;
}

export interface WarmupOverPayload {
  finalScore: number;
  playerBests: Record<string, number>;
  pairBest: number;
  isNewPlayerBest: Record<string, boolean>;
  isNewPairBest: boolean;
}

export interface WarmupRestartedPayload {
  firstTurnUserId: string;
}

export interface WarmupScoresPayload {
  playerBest: number;
  pairBest: number;
}

export interface PresenceOnlineCountPayload {
  onlineUsers: number;
}

export type SessionStateKind =
  | 'IDLE'
  | 'IN_QUEUE'
  | 'IN_WAITING_LOBBY'
  | 'IN_ACTIVE_MATCH'
  | 'CORRUPT_MULTI_STATE';

export interface SessionStatePayload {
  state: SessionStateKind;
  activeMatchId: string | null;
  waitingLobbyId: string | null;
  queueSearchId: string | null;
  openLobbyIds: string[];
  resolvedAt: string;
}

export interface SessionBlockedPayload {
  reason:
    | 'ACTIVE_MATCH'
    | 'TRANSITION_IN_PROGRESS'
    | 'INVALID_INVITE'
    | 'LOBBY_NOT_FOUND'
    | 'QUEUE_UNAVAILABLE';
  message: string;
  operation?: string;
  stateSnapshot: SessionStatePayload;
}

export interface ClientToServerEvents {
  'lobby:create': (data: { mode: MatchMode; isPublic?: boolean }) => void;
  'lobby:join_by_code': (data: { inviteCode: string }) => void;
  'lobby:leave': () => void;
  'lobby:ready': (data: { ready: boolean }) => void;
  'lobby:update_settings': (data: {
    lobbyId?: string;
    gameMode: LobbyGameMode;
    friendlyRandom?: boolean;
    friendlyCategoryAId?: string | null;
    friendlyCategoryBId?: string | null;
    isPublic?: boolean;
  }) => void;
  'lobby:start': (data?: { lobbyId?: string }) => void;
  'ranked:queue_join': (data?: RankedQueueJoinPayload) => void;
  'ranked:queue_leave': () => void;
  'draft:ban': (data: { categoryId: string }) => void;
  'match:answer': (data: { matchId: string; qIndex: number; selectedIndex: number | null; timeMs: number }) => void;
  'match:tactic_select': (data: { matchId: string; tactic: TacticalCard }) => void;
  'match:leave': (data?: { matchId?: string }) => void;
  'match:rejoin': (data?: { matchId?: string }) => void;
  'match:forfeit': (data?: { matchId?: string }) => void;
  'match:final_results_ack': (data: { matchId: string; resultVersion: number }) => void;
  'warmup:tap': (data: WarmupTapPayload) => void;
  'warmup:dropped': (data: WarmupDroppedPayload) => void;
  'warmup:restart': () => void;
  'warmup:get_scores': () => void;
  'dev:quick_match': () => void;
  'dev:skip_to': (data: { matchId: string; target: 'halftime' | 'shot' | 'penalties' | 'second_half' }) => void;
}

export interface ErrorPayload {
  code: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface ServerToClientEvents {
  'error': (data: ErrorPayload) => void;
  'presence:online_count': (data: PresenceOnlineCountPayload) => void;
  'session:state': (data: SessionStatePayload) => void;
  'session:blocked': (data: SessionBlockedPayload) => void;
  'lobby:state': (data: LobbyState) => void;
  'draft:start': (data: DraftState) => void;
  'draft:banned': (data: { actorId: string; categoryId: string }) => void;
  'draft:complete': (data: { allowedCategoryIds: [string, string] }) => void;
  'match:start': (data: MatchStartPayload) => void;
  'match:countdown': (data: MatchCountdownPayload) => void;
  'match:state': (data: MatchStatePayload) => void;
  'match:question': (data: MatchQuestionPayload) => void;
  'match:opponent_answered': (data: MatchOpponentAnsweredPayload) => void;
  'match:answer_ack': (data: MatchAnswerAckPayload) => void;
  'match:round_result': (data: MatchRoundResultPayload) => void;
  'match:final_results': (data: MatchFinalResultsPayload) => void;
  'match:opponent_disconnected': (data: MatchOpponentDisconnectedPayload) => void;
  'match:resume': (data: MatchResumePayload) => void;
  'match:rejoin_available': (data: MatchRejoinAvailablePayload) => void;
  'ranked:search_started': (data: RankedSearchStartedPayload) => void;
  'ranked:match_found': (data: RankedMatchFoundPayload) => void;
  'ranked:queue_left': () => void;
  'warmup:state': (data: WarmupStatePayload) => void;
  'warmup:tapped': (data: WarmupTappedPayload) => void;
  'warmup:over': (data: WarmupOverPayload) => void;
  'warmup:restarted': (data: WarmupRestartedPayload) => void;
  'warmup:scores': (data: WarmupScoresPayload) => void;
}
