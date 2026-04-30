import type { AvatarCustomization } from '../modules/users/avatar-customization.js';

export type MatchMode = 'friendly' | 'ranked';
export type LobbyGameMode = 'friendly_possession' | 'friendly_party_quiz' | 'ranked_sim';
export type MatchVariant = LobbyGameMode;
export type LobbyStatus = 'waiting' | 'active' | 'closed';
export type MatchPhase =
  | 'NORMAL_PLAY'
  | 'LAST_ATTACK'
  /** @deprecated Kept for compatibility with historical data only. */
  | 'SHOT_ON_GOAL'
  | 'HALFTIME'
  | 'PENALTY_SHOOTOUT'
  | 'COMPLETED';
export type MatchPhaseKind =
  | 'normal'
  | 'last_attack'
  /** @deprecated Kept for compatibility with historical data only. */
  | 'shot'
  | 'penalty';
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
  avatarCustomization?: AvatarCustomization | null;
  isReady: boolean;
  isHost: boolean;
}

export interface MatchParticipant {
  userId: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization?: AvatarCustomization | null;
  seat: number;
  rankPoints?: number;
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
  imageUrl: string | null;
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
  avatarCustomization?: AvatarCustomization | null;
  rp?: number;
  country?: string;
  countryCode?: string;
  city?: string;
  flag?: string;
  lat?: number;
  lon?: number;
}

export type MatchQuestionKind =
  | 'multipleChoice'
  | 'countdown'
  | 'putInOrder'
  | 'clues';

export interface MultipleChoiceQuestionDTO {
  kind: 'multipleChoice';
  id: string;
  prompt: Record<string, string>;
  options: Array<Record<string, string>>;
  categoryId?: string;
  categoryName?: Record<string, string>;
  difficulty?: string;
  explanation?: string | null;
}

export interface CountdownQuestionDTO {
  kind: 'countdown';
  id: string;
  prompt: Record<string, string>;
  answerSlotCount: number;
  categoryId?: string;
  categoryName?: Record<string, string>;
  difficulty?: string;
}

export interface PutInOrderQuestionItemDTO {
  id: string;
  label: Record<string, string>;
  details?: Record<string, string> | null;
  emoji?: string | null;
}

export interface PutInOrderQuestionDTO {
  kind: 'putInOrder';
  id: string;
  prompt: Record<string, string>;
  instruction: Record<string, string>;
  direction: 'asc' | 'desc';
  items: PutInOrderQuestionItemDTO[];
  categoryId?: string;
  categoryName?: Record<string, string>;
  difficulty?: string;
}

export interface ClueItemDTO {
  type: 'text' | 'emoji';
  content: Record<string, string>;
}

export interface CluesQuestionDTO {
  kind: 'clues';
  id: string;
  prompt: Record<string, string>;
  clues: ClueItemDTO[];
  categoryId?: string;
  categoryName?: Record<string, string>;
  difficulty?: string;
}

export type GameQuestionDTO =
  | MultipleChoiceQuestionDTO
  | CountdownQuestionDTO
  | PutInOrderQuestionDTO
  | CluesQuestionDTO;

export interface MatchStartPayload {
  matchId: string;
  mode: MatchMode;
  variant: MatchVariant;
  mySeat?: number;
  opponent: OpponentInfo;
  participants: MatchParticipant[];
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
  playableAt?: string;
  deadlineAt: string;
  phaseKind?: MatchPhaseKind;
  phaseRound?: number | null;
  shooterSeat?: 1 | 2 | null;
  attackerSeat?: 1 | 2 | null;
}

export interface MatchChanceCardUsePayload {
  matchId: string;
  qIndex: number;
  clientActionId: string;
}

export interface MatchPlayAgainPayload {
  matchId: string;
}

export interface MatchChanceCardAppliedPayload {
  matchId: string;
  qIndex: number;
  clientActionId: string;
  eliminatedIndices: number[];
  remainingQuantity: number;
}

export interface MatchOpponentAnsweredPayload {
  matchId: string;
  qIndex: number;
  questionKind: MatchQuestionKind;
  opponentTotalPoints: number;
  pointsEarned: number;
  isCorrect: boolean;
  selectedIndex: number | null;
}

export interface MatchAnswerAckPayload {
  matchId: string;
  qIndex: number;
  questionKind: MatchQuestionKind;
  selectedIndex: number | null;
  isCorrect: boolean;
  correctIndex?: number;
  myTotalPoints: number;
  oppAnswered: boolean;
  pointsEarned: number;
  phaseKind?: MatchPhaseKind;
  phaseRound?: number | null;
  shooterSeat?: 1 | 2 | null;
  foundCount?: number;
  clueIndex?: number | null;
}

export interface MatchCountdownGuessAckPayload {
  matchId: string;
  qIndex: number;
  accepted: boolean;
  duplicate: boolean;
  foundCount: number;
  acceptedDisplay?: Record<string, string>;
}

export interface MatchCluesGuessAckPayload {
  matchId: string;
  qIndex: number;
  clueIndex: number;
  revealCount: number;
}

export interface MatchRoundResultPlayer {
  selectedIndex: number | null;
  isCorrect: boolean;
  timeMs: number;
  pointsEarned: number;
  totalPoints: number;
  foundCount?: number;
  clueIndex?: number | null;
}

export interface MatchRoundResultDeltas {
  possessionDelta: number;
  penaltyOutcome: 'goal' | 'saved' | null;
  goalScoredBySeat: 1 | 2 | null;
}

export interface MultipleChoiceRoundReveal {
  kind: 'multipleChoice';
  correctIndex: number;
}

export interface CountdownRoundReveal {
  kind: 'countdown';
  answerGroups: Array<{
    id: string;
    display: Record<string, string>;
  }>;
}

export interface PutInOrderRoundReveal {
  kind: 'putInOrder';
  correctOrder: Array<{
    id: string;
    label: Record<string, string>;
    details?: Record<string, string> | null;
    emoji?: string | null;
    sortValue: number;
  }>;
}

export interface CluesRoundReveal {
  kind: 'clues';
  displayAnswer: Record<string, string>;
}

/**
 * Discriminated union of round-reveal payloads.
 * The `kind` discriminant is the source-of-truth for question type within a
 * round result and must always match the sibling `questionKind` field on
 * {@link MatchRoundResultPayload}.
 */
export type MatchRoundReveal =
  | MultipleChoiceRoundReveal
  | CountdownRoundReveal
  | PutInOrderRoundReveal
  | CluesRoundReveal;

export interface MatchRoundResultPayload {
  matchId: string;
  qIndex: number;
  /**
   * Convenience field for quick branching by question type.
   * Must always equal `reveal.kind`; the reveal discriminant is the
   * source-of-truth for type-narrowing reveal-specific data.
   */
  questionKind: MatchQuestionKind;
  correctIndex?: number;
  /** Discriminated union — narrow via `reveal.kind` to access variant data. */
  reveal: MatchRoundReveal;
  players: Record<string, MatchRoundResultPlayer>;
  rankingOrder?: string[];
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

export interface MatchStandingPayload {
  userId: string;
  rank: number;
  totalPoints: number;
  correctAnswers: number;
  avgTimeMs: number | null;
}

export interface AchievementUnlockPayload {
  id: string;
  title: string;
  description: string;
  icon: string;
  unlocked: boolean;
  progress: number;
  target: number;
  unlockedAt: string | null;
}

export interface RankedUserOutcomePayload {
  userId: string;
  oldRp: number;
  newRp: number;
  deltaRp: number;
  oldTier: string;
  newTier: string;
  placementStatus: 'unplaced' | 'in_progress' | 'placed';
  placementPlayed: number;
  placementRequired: number;
  isPlacement: boolean;
}

export interface RankedMatchOutcomePayload {
  isPlacement: boolean;
  byUserId: Record<string, RankedUserOutcomePayload>;
}

export interface MatchFinalResultsPayload {
  matchId: string;
  winnerId: string | null;
  players: Record<string, MatchFinalResultPlayer>;
  standings?: MatchStandingPayload[];
  unlockedAchievements?: Record<string, AchievementUnlockPayload[]>;
  durationMs: number;
  resultVersion: number;
  winnerDecisionMethod?: 'goals' | 'penalty_goals' | 'total_points' | 'total_points_fallback' | 'forfeit' | null;
  totalPointsFallbackUsed?: boolean;
  rankedOutcome?: RankedMatchOutcomePayload | null;
}

export interface MatchStatePayload {
  matchId: string;
  phase: MatchPhase;
  half: 1 | 2;
  possessionDiff: number;
  normalQuestionsAnsweredInHalf: number;
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
  halftime: {
    deadlineAt: string | null;
    categoryOptions: DraftCategory[];
    firstBanSeat: 1 | 2 | null;
    bans: {
      seat1: string | null;
      seat2: string | null;
    };
  };
  penaltySuddenDeath?: boolean;
  stateVersion?: number;
}

export interface MatchPartyPlayerState {
  userId: string;
  totalPoints: number;
  correctAnswers: number;
  answered: boolean;
  rank: number;
  avgTimeMs: number | null;
}

export interface MatchPartyStatePayload {
  matchId: string;
  totalQuestions: number;
  currentQuestionIndex: number;
  leaderUserId: string | null;
  rankingOrder: string[];
  players: MatchPartyPlayerState[];
  stateVersion: number;
}

export interface MatchOpponentDisconnectedPayload {
  matchId: string;
  opponentId: string;
  graceMs: number;
  remainingReconnects: number;
}

export interface MatchResumePayload {
  matchId: string;
  nextQIndex: number;
}

export interface MatchRejoinAvailablePayload {
  matchId: string;
  mode: MatchMode;
  variant: MatchVariant;
  opponent: OpponentInfo;
  participants: MatchParticipant[];
  graceMs: number;
  remainingReconnects: number;
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

export interface MatchCluesAnswerGuessPayload {
  kind: 'guess';
  matchId: string;
  qIndex: number;
  guess: string;
  timeMs: number;
}

export interface MatchCluesAnswerGiveUpPayload {
  kind: 'giveUp';
  matchId: string;
  qIndex: number;
  giveUp: true;
  timeMs: number;
}

export type MatchCluesAnswerPayload =
  | MatchCluesAnswerGuessPayload
  | MatchCluesAnswerGiveUpPayload;

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
  'match:countdown_guess': (data: { matchId: string; qIndex: number; guess: string }) => void;
  'match:put_in_order_answer': (data: { matchId: string; qIndex: number; orderedItemIds: string[]; timeMs: number }) => void;
  'match:clues_answer': (data: MatchCluesAnswerPayload) => void;
  'match:chance_card_use': (data: MatchChanceCardUsePayload) => void;
  'match:halftime_ban': (data: { matchId: string; categoryId: string }) => void;
  'match:halftime_ui_ready': (data: { matchId: string }) => void;
  'match:leave': (data?: { matchId?: string }) => void;
  'match:rejoin': (data?: { matchId?: string }) => void;
  'match:forfeit': (data?: { matchId?: string }) => void;
  'match:play_again': (data: MatchPlayAgainPayload) => void;
  'match:final_results_ack': (data: { matchId: string; resultVersion: number }) => void;
  'match:ready_for_next_question': (data: { matchId: string; qIndex: number }) => void;
  'warmup:tap': (data: WarmupTapPayload) => void;
  'warmup:dropped': (data: WarmupDroppedPayload) => void;
  'warmup:restart': () => void;
  'warmup:get_scores': () => void;
  'dev:quick_match': () => void;
  'dev:skip_to': (data: { matchId: string; target: 'halftime' | 'last_attack' | 'shot' | 'penalties' | 'second_half' }) => void;
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
  'draft:complete': (data: { halfOneCategoryId: string }) => void;
  'match:start': (data: MatchStartPayload) => void;
  'match:countdown': (data: MatchCountdownPayload) => void;
  'match:state': (data: MatchStatePayload) => void;
  'match:party_state': (data: MatchPartyStatePayload) => void;
  'match:question': (data: MatchQuestionPayload) => void;
  'match:chance_card_applied': (data: MatchChanceCardAppliedPayload) => void;
  'match:opponent_answered': (data: MatchOpponentAnsweredPayload) => void;
  'match:answer_ack': (data: MatchAnswerAckPayload) => void;
  'match:countdown_guess_ack': (data: MatchCountdownGuessAckPayload) => void;
  'match:clues_guess_ack': (data: MatchCluesGuessAckPayload) => void;
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
