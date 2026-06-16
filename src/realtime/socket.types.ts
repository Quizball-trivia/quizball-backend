import type { AvatarCustomization } from '../modules/users/avatar-customization.js';
import type { I18nField } from '../db/types.js';

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
  country?: string;
  countryCode?: string;
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
  /**
   * Full i18n object (e.g. { en, ka }) so the client can localize the category
   * name to each viewer's language. The draft payload is broadcast to a lobby
   * room that may contain players with different languages, so the name must not
   * be collapsed to a single locale server-side.
   */
  name: I18nField;
  icon: string | null;
  imageUrl: string | null;
}

export interface DraftState {
  lobbyId: string;
  categories: DraftCategory[];
  turnUserId: string;
  /**
   * Info flag: the candidates were selected with recent-category filtering
   * (recently played categories of the matched players were excluded). The
   * client just displays the categories — no client-side filtering.
   * Omitted on reconnect re-emits of an in-progress draft.
   */
  recentFilterApplied?: boolean;
}

export interface DraftOpponentDisconnectedPayload {
  lobbyId: string;
  opponentId: string;
  graceMs: number;
}

export interface DraftResumePayload {
  lobbyId: string;
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
  /** Opponent's favorite club (display name). Used by the showdown screen to render the club logo + primary-color chip. */
  favoriteClub?: string | null;
  /** Last few completed-match results (most recent first), e.g. ['W','L','W']. Used by the showdown form-strip. */
  recentForm?: Array<'W' | 'L' | 'D'>;
  lat?: number;
  lon?: number;
  /** Opponent's last reported connection RTT (ms), for the showdown ping pill.
   *  null/undefined when no recent reading is available. */
  pingMs?: number | null;
}

export type MatchQuestionKind =
  | 'multipleChoice'
  | 'countdown'
  | 'putInOrder'
  | 'clues';

/** Image attached to an image-MCQ. Minimal, normalized shape for the client
 *  (width/height let it reserve space and avoid layout shift). */
export interface QuestionImageDTO {
  url: string;
  width: number;
  height: number;
  aspectRatio?: string;
}

export interface MultipleChoiceQuestionDTO {
  kind: 'multipleChoice';
  id: string;
  prompt: Record<string, string>;
  options: Array<Record<string, string>>;
  image?: QuestionImageDTO;
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
  /** Recipient's own last 3 match results (most recent first). Used by the showdown form-strip. */
  myRecentForm?: Array<'W' | 'L' | 'D'>;
  participants: MatchParticipant[];
  /** Resolved first-half category name (i18n). Lets the client skip the placeholder/flicker on the round-1 intro. */
  categoryName?: Record<string, string>;
}

export interface MatchCountdownPayload {
  matchId: string;
  seconds: number;
  startsAt: string;
  serverNow?: string;
  reason?: 'kickoff' | 'resume';
}

export type MatchUiReadyPhase = 'kickoff' | 'resume';

export type MatchStagePresencePayload = {
  matchId: string;
  stageKey: string;
};

export interface MatchWaitingForReadyPayload {
  matchId: string;
  phase: MatchUiReadyPhase;
  readyCount: number;
  totalCount: number;
  forceStartsAt: string;
  serverNow?: string;
}

export interface MatchQuestionPayload {
  matchId: string;
  qIndex: number;
  total: number;
  question: GameQuestionDTO;
  playableAt?: string;
  deadlineAt: string;
  serverNow?: string;
  correctIndex?: number;
  phaseKind?: MatchPhaseKind;
  phaseRound?: number | null;
  shooterSeat?: 1 | 2 | null;
  attackerSeat?: 1 | 2 | null;
}

export interface MatchPlayAgainPayload {
  matchId: string;
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
  cluesDisplayAnswer?: Record<string, string>;
  submittedOrderIds?: string[];
}

export interface MatchCountdownGuessAckPayload {
  matchId: string;
  qIndex: number;
  accepted: boolean;
  duplicate: boolean;
  foundCount: number;
  acceptedDisplay?: Record<string, string>;
  acceptedDisplays?: Array<Record<string, string>>;
}

export interface MatchOpponentCountdownProgressPayload {
  matchId: string;
  qIndex: number;
  opponentUserId: string;
  foundCount: number;
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
  /** Points used for possession movement after applying any current-round 2x boost. */
  possessionPointsEarned?: number;
  totalPoints: number;
  foundCount?: number;
  foundAnswerIds?: string[];
  submittedOrderIds: string[];
  clueIndex?: number | null;
}

export interface MatchRoundResultDeltas {
  possessionDelta: number;
  penaltyOutcome: 'goal' | 'saved' | null;
  goalScoredBySeat: 1 | 2 | null;
  /** Seat whose possession gain was doubled by the 2× speed streak THIS round
   *  (the previous holder). null when no boost was applied. The live streak
   *  holder for the NEXT round travels in the match state payload. */
  speedStreakBoostedSeat?: 1 | 2 | null;
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

/**
 * Sent to the client when an achievement unlocks during a match.
 * Single source of truth lives in the achievements module so the I18nField
 * shape (`{ en, ka, ... }`) stays consistent across HTTP + socket layers.
 */
import type { AchievementUnlockPayload } from '../modules/achievements/achievements.types.js';
export type { AchievementUnlockPayload };

export interface RankedUserOutcomePayload {
  userId: string;
  oldRp: number;
  newRp: number;
  deltaRp: number;
  /** Coin participation reward granted with the ranked settlement (win/loss). */
  coinsAwarded?: number;
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
  variant?: 'friendly_possession' | 'friendly_party_quiz' | 'ranked_sim';
  winnerId: string | null;
  players: Record<string, MatchFinalResultPlayer>;
  participants?: MatchParticipant[];
  standings?: MatchStandingPayload[];
  totalQuestions?: number;
  questionResults?: Record<string, Array<'correct' | 'wrong' | null>>;
  unlockedAchievements?: Record<string, AchievementUnlockPayload[]>;
  durationMs: number;
  resultVersion: number;
  winnerDecisionMethod?: 'goals' | 'penalty_goals' | 'total_points' | 'total_points_fallback' | 'forfeit' | null;
  cancelledNoContest?: boolean;
  totalPointsFallbackUsed?: boolean;
  rankedOutcome?: RankedMatchOutcomePayload | null;
}

export interface MatchForfeitPendingPayload {
  matchId: string;
  reason: 'reconnect_limit' | 'opponent_forfeit' | 'opponent_reconnect_limit';
  message: string;
}

export interface MatchStatePayload {
  matchId: string;
  phase: MatchPhase;
  half: 1 | 2;
  possessionDiff: number;
  /** Live 2× speed-streak holder (drives the sticky HUD badge). null = none. */
  speedStreakHolderSeat?: 1 | 2 | null;
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
  penaltyAttempts?: {
    seat1: Array<'goal' | 'miss'>;
    seat2: Array<'goal' | 'miss'>;
  };
  phaseKind: MatchPhaseKind;
  phaseRound: number;
  shooterSeat: 1 | 2 | null;
  halftime: {
    deadlineAt: string | null;
    uiReadyAt: string | null;
    categoryOptions: DraftCategory[];
    firstBanSeat: 1 | 2 | null;
    bans: {
      seat1: string | null;
      seat2: string | null;
    };
    /** Whether this ban interlude is the second-half pick or the pre-penalty pick. */
    purpose?: 'second_half' | 'penalty';
  };
  penaltySuddenDeath?: boolean;
  stateVersion?: number;
  /**
   * Raw image URLs the client should preload (optimized client-side) for
   * upcoming questions in the current half — e.g. the reserved image-MCQ
   * picture, sent from the half's first question so it's warm by Q4.
   */
  preloadImageUrls?: string[];
}

export interface MatchPartyPlayerState {
  userId: string;
  totalPoints: number;
  correctAnswers: number;
  answered: boolean;
  rank: number;
  avgTimeMs: number | null;
  status: 'active' | 'dropped';
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

export interface MatchPartyDropoutPayload {
  matchId: string;
  reason: 'disconnect_timeout' | 'self_forfeit';
  message: string;
}

export interface RankedSearchStartedPayload {
  durationMs: number;
}

export interface RankedMatchFoundPayload {
  lobbyId: string;
  opponent: OpponentInfo;
  /** Recipient's own last 3 match results (most recent first). */
  myRecentForm?: Array<'W' | 'L' | 'D'>;
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

export type LobbyCreateResult =
  | {
      ok: true;
      lobbyId: string | null;
      inviteCode: string | null;
      correlationId: string;
    }
  | {
      ok: false;
      code: 'ALREADY_IN_LOBBY' | 'TRANSITION_IN_PROGRESS' | 'INVALID_LOBBY_CREATE' | 'LOBBY_CREATE_ERROR';
      message: string;
      retryable: boolean;
      correlationId: string;
      stateSnapshot?: SessionStatePayload;
    };

export type LobbyJoinByCodeResult =
  | {
      ok: true;
      lobbyId: string;
      inviteCode: string;
      alreadyMember: boolean;
      correlationId: string;
    }
  | {
      ok: false;
      code:
        | 'ALREADY_IN_LOBBY'
        | 'LOBBY_NOT_FOUND'
        | 'LOBBY_FULL'
        | 'TRANSITION_IN_PROGRESS'
        | 'INVALID_INVITE'
        | 'LOBBY_JOIN_ERROR';
      message: string;
      retryable: boolean;
      correlationId: string;
      stateSnapshot?: SessionStatePayload;
    };

export type LobbyLeaveResult =
  | {
      ok: true;
      lobbyId: string | null;
      closed: boolean;
      correlationId: string;
    }
  | {
      ok: false;
      code: 'LOBBY_BUSY' | 'LOBBY_ACTIVE' | 'TRANSITION_IN_PROGRESS' | 'LOBBY_LEAVE_ERROR';
      message: string;
      retryable: boolean;
      correlationId: string;
      stateSnapshot?: SessionStatePayload;
    };

export interface LobbyChallengeUser {
  id: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization?: AvatarCustomization | null;
}

export interface LobbyChallengeInvitePayload {
  invitationId: string;
  lobbyId: string;
  inviteCode: string;
  fromUser: LobbyChallengeUser;
  expiresAt: string;
}

export interface LobbyChallengeCreatedPayload {
  invitationId: string;
  lobbyId: string;
  inviteCode: string;
  toUserId: string;
}

export interface LobbyChallengeStatusPayload {
  invitationId: string;
  status: 'accepted' | 'declined' | 'canceled' | 'expired';
  toUserId: string;
  lobbyId?: string;
  inviteCode?: string;
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
  'lobby:create': (
    data: { mode: MatchMode; isPublic?: boolean; correlationId?: string },
    ack?: (result: LobbyCreateResult) => void
  ) => void;
  'lobby:challenge': (data: { toUserId: string }) => void;
  'lobby:challenge_accept': (data: { invitationId: string }) => void;
  'lobby:challenge_decline': (data: { invitationId: string }) => void;
  'lobby:join_by_code': (
    data: { inviteCode: string; correlationId?: string },
    ack?: (result: LobbyJoinByCodeResult) => void
  ) => void;
  'lobby:leave': (data?: { correlationId?: string }, ack?: (result: LobbyLeaveResult) => void) => void;
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
  'draft:rejoin': (data?: { lobbyId?: string }) => void;
  'draft:ui_ready': (data?: { lobbyId?: string; turnUserId?: string; banCount?: number }) => void;
  'draft:ban': (data: { categoryId: string }) => void;
  'match:answer': (data: { matchId: string; qIndex: number; selectedIndex: number | null; timeMs: number }) => void;
  'match:countdown_guess': (data: { matchId: string; qIndex: number; guess: string }) => void;
  'match:put_in_order_answer': (data: { matchId: string; qIndex: number; orderedItemIds: string[]; timeMs: number }) => void;
  'match:clues_answer': (data: MatchCluesAnswerPayload) => void;
  'match:halftime_ban': (data: { matchId: string; categoryId: string }) => void;
  'match:halftime_ui_ready': (data: { matchId: string }) => void;
  'match:kickoff_ui_ready': (data: { matchId: string }) => void;
  'match:resume_ui_ready': (data: { matchId: string }) => void;
  'match:presence_heartbeat': (data: MatchStagePresencePayload) => void;
  'match:stage_ready': (data: MatchStagePresencePayload) => void;
  'match:leave': (data?: { matchId?: string }) => void;
  'match:rejoin': (data?: { matchId?: string }) => void;
  'match:forfeit': (data?: { matchId?: string }) => void;
  'match:play_again': (data: MatchPlayAgainPayload) => void;
  'match:final_results_ack': (data: { matchId: string; resultVersion: number }) => void;
  'match:ready_for_next_question': (data: { matchId: string; qIndex: number }) => void;
  'connection:ping': (
    data: { sentAt: number },
    ack?: (result: { sentAt: number; serverNow: string }) => void
  ) => void;
  // Client reports its own measured RTT so the opponent can be shown this
  // player's ping (the server doesn't otherwise know it). Stored per-user with
  // a short TTL; surfaced as opponentInfo.pingMs on the match/showdown payload.
  'connection:rtt': (data: { rttMs: number }) => void;
  'warmup:tap': (data: WarmupTapPayload) => void;
  'warmup:dropped': (data: WarmupDroppedPayload) => void;
  'warmup:restart': () => void;
  'warmup:get_scores': () => void;
  'dev:quick_match': (data?: { skipTo?: 'halftime' | 'last_attack' | 'shot' | 'penalties' | 'penalty_ban' | 'second_half' }) => void;
  'dev:skip_to': (data: { matchId: string; target: 'halftime' | 'last_attack' | 'shot' | 'penalties' | 'penalty_ban' | 'second_half' }) => void;
  'dev:pause_match': (data: { matchId: string }) => void;
  'dev:resume_match': (data: { matchId: string }) => void;
}

export interface ErrorPayload {
  code: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface ForceLogoutPayload {
  reason: 'account_deleted' | 'admin_revoked';
}

export interface NotificationPayload {
  id: string;
  type: string;
  title: Record<string, string>;
  body: Record<string, string> | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationUnreadCountPayload {
  unreadCount: number;
}

export interface ServerToClientEvents {
  'error': (data: ErrorPayload) => void;
  'presence:online_count': (data: PresenceOnlineCountPayload) => void;
  'notification:new': (data: NotificationPayload) => void;
  'notification:unread_count': (data: NotificationUnreadCountPayload) => void;
  'session:state': (data: SessionStatePayload) => void;
  'session:blocked': (data: SessionBlockedPayload) => void;
  'auth:force_logout': (data: ForceLogoutPayload) => void;
  'lobby:state': (data: LobbyState) => void;
  'lobby:challenge_created': (data: LobbyChallengeCreatedPayload) => void;
  'lobby:challenge_received': (data: LobbyChallengeInvitePayload) => void;
  'lobby:challenge_status': (data: LobbyChallengeStatusPayload) => void;
  'draft:start': (data: DraftState) => void;
  'draft:banned': (data: { actorId: string; categoryId: string }) => void;
  'draft:complete': (data: { halfOneCategoryId: string }) => void;
  'draft:opponent_disconnected': (data: DraftOpponentDisconnectedPayload) => void;
  'draft:resume': (data: DraftResumePayload) => void;
  'match:start': (data: MatchStartPayload) => void;
  'match:waiting_for_ready': (data: MatchWaitingForReadyPayload) => void;
  'match:countdown': (data: MatchCountdownPayload) => void;
  'match:state': (data: MatchStatePayload) => void;
  'match:party_state': (data: MatchPartyStatePayload) => void;
  'match:question': (data: MatchQuestionPayload) => void;
  'match:opponent_answered': (data: MatchOpponentAnsweredPayload) => void;
  'match:answer_ack': (data: MatchAnswerAckPayload) => void;
  'match:countdown_guess_ack': (data: MatchCountdownGuessAckPayload) => void;
  'match:opponent_countdown_progress': (data: MatchOpponentCountdownProgressPayload) => void;
  'match:clues_guess_ack': (data: MatchCluesGuessAckPayload) => void;
  'match:round_result': (data: MatchRoundResultPayload) => void;
  'match:final_results': (data: MatchFinalResultsPayload) => void;
  'match:forfeit_pending': (data: MatchForfeitPendingPayload) => void;
  'match:opponent_disconnected': (data: MatchOpponentDisconnectedPayload) => void;
  'match:party_dropout': (data: MatchPartyDropoutPayload) => void;
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
