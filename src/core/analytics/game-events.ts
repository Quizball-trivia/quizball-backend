import { stableAnalyticsEventUuid, trackEvent } from '../analytics.js';

// Match Events
export function trackMatchCreated(
  userId: string,
  matchId: string,
  mode: string,
  categoryId?: string
): void {
  trackEvent('match_created', userId, {
    match_id: matchId,
    mode,
    category_id: categoryId,
  });
}

export interface TrackMatchCompletedOptions {
  userId: string;
  matchId: string;
  mode: string;
  won: boolean;
  score: number;
  opponentScore: number;
  durationMs: number;
  goalsFor?: number;
  goalsAgainst?: number;
  penaltyGoalsFor?: number;
  penaltyGoalsAgainst?: number;
  winnerDecisionMethod?: string | null;
  totalQuestions?: number;
  correctAnswers?: number;
  opponentIsAi?: boolean;
}

export function trackMatchCompleted({
  userId,
  matchId,
  mode,
  won,
  score,
  opponentScore,
  durationMs,
  goalsFor,
  goalsAgainst,
  penaltyGoalsFor,
  penaltyGoalsAgainst,
  winnerDecisionMethod,
  totalQuestions,
  correctAnswers,
  opponentIsAi,
}: TrackMatchCompletedOptions): void {
  const accuracy =
    totalQuestions != null && totalQuestions > 0 && correctAnswers != null
      ? Math.round((correctAnswers / totalQuestions) * 100)
      : undefined;

  trackEvent('match_completed', userId, {
    match_id: matchId,
    mode,
    won,
    score,
    opponent_score: opponentScore,
    duration_ms: durationMs,
    goals_for: goalsFor,
    goals_against: goalsAgainst,
    penalty_goals_for: penaltyGoalsFor,
    penalty_goals_against: penaltyGoalsAgainst,
    winner_decision_method: winnerDecisionMethod,
    total_questions: totalQuestions,
    correct_answers: correctAnswers,
    accuracy,
    opponent_is_ai: opponentIsAi,
  });
}

export function trackMatchAbandoned(
  userId: string,
  matchId: string,
  mode: string,
  reason: string
): void {
  trackEvent('match_abandoned', userId, {
    match_id: matchId,
    mode,
    reason,
  });
}

// Lobby Events
export function trackLobbyCreated(
  userId: string,
  lobbyId: string,
  mode: string
): void {
  trackEvent('lobby_created', userId, {
    lobby_id: lobbyId,
    mode,
  });
}

export function trackLobbyJoined(
  userId: string,
  lobbyId: string,
  inviteCode?: string
): void {
  trackEvent('lobby_joined', userId, {
    lobby_id: lobbyId,
    via_invite_code: !!inviteCode,
  });
}

export function trackLobbyLeft(
  userId: string,
  lobbyId: string,
  reason: string
): void {
  trackEvent('lobby_left', userId, {
    lobby_id: lobbyId,
    reason,
  });
}

// Ranked Queue Events
interface RankedQueueClientContext {
  source?: string | null;
  clientReason?: string | null;
  clientRequestId?: string | null;
  socketId?: string | null;
}

function idPrefix(id?: string | null): string | null {
  return id ? id.slice(0, 8) : null;
}

export function trackRankedQueueJoined(
  userId: string,
  rankPoints: number,
  context: RankedQueueClientContext & {
    searchId?: string | null;
    queueSize?: number | null;
  } = {}
): void {
  trackEvent('ranked_queue_joined', userId, {
    rank_points: rankPoints,
    source: context.source ?? null,
    client_reason: context.clientReason ?? null,
    client_request_id: context.clientRequestId ?? null,
    socket_id: context.socketId ?? null,
    search_id_prefix: idPrefix(context.searchId),
    queue_size: context.queueSize ?? null,
  });
}

export function trackRankedQueueLeft(params: {
  userId: string;
  source: 'explicit_leave' | 'disconnect_cleanup' | 'server_abort';
  searchFound: boolean;
  searchId?: string | null;
}): void {
  trackEvent('ranked_queue_left', params.userId, {
    source: params.source,
    search_found: params.searchFound,
    search_id_prefix: idPrefix(params.searchId),
  });
}

export function trackRankedQueueJoinIgnored(params: RankedQueueClientContext & {
  userId: string;
  reason:
    | 'existing_session'
    | 'recent_queue_leave'
    | 'insufficient_tickets'
    | 'transition_lock_busy';
  sessionState?: string | null;
  activeMatchId?: string | null;
  waitingLobbyId?: string | null;
  queueSearchId?: string | null;
}): void {
  trackEvent('ranked_queue_join_ignored', params.userId, {
    reason: params.reason,
    source: params.source ?? null,
    client_reason: params.clientReason ?? null,
    client_request_id: params.clientRequestId ?? null,
    socket_id: params.socketId ?? null,
    session_state: params.sessionState ?? null,
    active_match_id_prefix: idPrefix(params.activeMatchId),
    waiting_lobby_id_prefix: idPrefix(params.waitingLobbyId),
    queue_search_id_prefix: idPrefix(params.queueSearchId),
  });
}

export function trackRankedMatchFound(
  userId: string,
  opponentUserId: string,
  timeSec: number
): void {
  trackEvent('ranked_match_found', userId, {
    opponent_user_id: opponentUserId,
    queue_time_seconds: timeSec,
  });
}

export function trackRankPointsChanged(
  userId: string,
  oldRp: number,
  newRp: number,
  reason: string
): void {
  trackEvent('rank_points_changed', userId, {
    old_rp: oldRp,
    new_rp: newRp,
    change: newRp - oldRp,
    reason,
  });
}

// User Progression Events
export function trackLevelUp(userId: string, newLevel: number): void {
  trackEvent('level_up', userId, {
    new_level: newLevel,
  });
}

export function trackAchievementUnlocked(
  userId: string,
  achievementId: string,
  achievementName: string
): void {
  trackEvent('achievement_unlocked', userId, {
    achievement_id: achievementId,
    achievement_name: achievementName,
  });
}

// Error Events
export function trackError(
  userId: string | undefined,
  errorCode: string,
  errorMessage: string,
  context?: Record<string, unknown>
): void {
  // Allowlist of safe context fields to prevent PII leakage
  const allowedKeys = [
    'device',
    'level',
    'module',
    'component',
    'stack',
    'statusCode',
    'method',
    'path',
    'duration',
    'attemptCount',
    'category',
    'severity',
  ];

  const sanitizedContext: Record<string, unknown> = {};
  if (context) {
    for (const key of allowedKeys) {
      if (key in context) {
        sanitizedContext[key] = context[key];
      }
    }
  }

  trackEvent('error_occurred', userId || 'anonymous', {
    error_code: errorCode,
    error_message: errorMessage,
    ...sanitizedContext,
  });
}

// WebSocket Events
// No-op in PostHog: socket connect/disconnect is high-volume (~23K/mo, the single
// biggest backend event source) and already captured in Railway's logs, so we
// don't pay PostHog ingest for it. Kept as stubs so call sites stay intact.
export function trackSocketConnected(_userId: string): void {
  // intentionally not sent to PostHog — see note above
}

export function trackSocketDisconnected(
  _userId: string,
  _reason: string,
  _durationMs: number
): void {
  // intentionally not sent to PostHog — see note above
}

// Possession-match round-level events
export function trackPenaltyTaken(params: {
  userId: string;
  matchId: string;
  scored: boolean;
  attemptNumber: number;
  /** Sudden-death (round > MAX_PENALTY_ROUNDS) vs regular phase */
  suddenDeath: boolean;
}): void {
  trackEvent('penalty_taken', params.userId, {
    match_id: params.matchId,
    scored: params.scored,
    attempt_number: params.attemptNumber,
    sudden_death: params.suddenDeath,
  });
}

export function trackPossessionPhaseEntered(params: {
  userId: string;
  matchId: string;
  phase: 'first_half' | 'second_half' | 'last_attack' | 'penalty';
}): void {
  trackEvent('possession_phase_entered', params.userId, {
    match_id: params.matchId,
    phase: params.phase,
  });
}

export function trackDraftStarted(params: {
  userId: string;
  lobbyId: string;
  mode: string;
}): void {
  trackEvent('draft_started', params.userId, {
    lobby_id: params.lobbyId,
    mode: params.mode,
  });
}

export function trackDraftCompleted(params: {
  userId: string;
  lobbyId: string;
  matchId: string;
  durationMs: number;
}): void {
  trackEvent('draft_completed', params.userId, {
    lobby_id: params.lobbyId,
    match_id: params.matchId,
    duration_ms: params.durationMs,
  });
}

export function trackDraftUiReady(params: {
  userId: string;
  lobbyId: string;
  mode: string;
  banCount: number;
  socketId?: string | null;
}): void {
  trackEvent('draft_ui_ready', params.userId, {
    lobby_id: params.lobbyId,
    mode: params.mode,
    ban_count: params.banCount,
    socket_id: params.socketId ?? null,
  });
}

export function trackRankedDraftAborted(params: {
  userId: string;
  lobbyId: string;
  reason: string;
  cancelled?: boolean;
  absentAfterGrace?: boolean;
  expectedUserId?: string | null;
  aiUserId?: string | null;
  banCount?: number | null;
  forceAtMs?: number | null;
}): void {
  trackEvent('ranked_draft_aborted_before_match', params.userId, {
    lobby_id: params.lobbyId,
    reason: params.reason,
    cancelled: params.cancelled ?? false,
    absent_after_grace: params.absentAfterGrace ?? false,
    expected_user_id: params.expectedUserId ?? null,
    ai_user_id: params.aiUserId ?? null,
    ban_count: params.banCount ?? null,
    force_at_ms: params.forceAtMs ?? null,
    ms_after_force: params.forceAtMs ? Math.max(0, Date.now() - params.forceAtMs) : null,
  });
}

export function trackPartyQuizStarted(params: {
  userId: string;
  matchId: string;
  playerCount: number;
}): void {
  trackEvent('party_quiz_started', params.userId, {
    match_id: params.matchId,
    player_count: params.playerCount,
  });
}

// Football Grid events deliberately stay aggregate and low-volume. Raw typed
// answers are never analytics properties; answer quality is summarized once on
// the authoritative completion event instead.
export function trackFootballGridQueueJoined(params: {
  userId: string;
  searchId: string;
  locale: 'en' | 'ka';
  queuedAt: string | Date;
}): void {
  trackEvent('football_grid_queue_joined', params.userId, {
    mode: 'football_grid',
    search_id_prefix: idPrefix(params.searchId),
    locale: params.locale,
  }, {
    uuid: stableAnalyticsEventUuid(`football-grid:queue-joined:${params.searchId}:${params.userId}`),
    occurredAt: params.queuedAt,
  });
}

export function trackFootballGridQueueLeft(params: {
  userId: string;
  searchId: string;
  reason: 'cancelled' | 'expired' | 'matched' | 'server_abort';
  queuedAt: string | Date;
  leftAt?: string | Date;
  opponentType?: 'human' | 'bot' | null;
}): void {
  const queuedAtMs = new Date(params.queuedAt).getTime();
  const leftAt = params.leftAt ? new Date(params.leftAt) : new Date();
  const waitMs = Number.isFinite(queuedAtMs) && Number.isFinite(leftAt.getTime())
    ? Math.max(0, leftAt.getTime() - queuedAtMs)
    : null;
  trackEvent('football_grid_queue_left', params.userId, {
    mode: 'football_grid',
    search_id_prefix: idPrefix(params.searchId),
    reason: params.reason,
    wait_ms: waitMs,
    opponent_type: params.opponentType ?? null,
  }, {
    uuid: stableAnalyticsEventUuid(`football-grid:queue-left:${params.searchId}:${params.userId}:${params.reason}`),
    occurredAt: leftAt,
  });
}

export function trackFootballGridMatchFound(params: {
  userId: string;
  matchId: string;
  searchId?: string | null;
  origin: 'random' | 'challenge' | 'private' | 'public' | 'code';
  opponentType: 'human' | 'bot';
  queueWaitMs?: number | null;
  boardId: string;
  boardVersion: number;
  boardDifficulty?: 'easy' | 'normal' | 'hard' | null;
  occurredAt?: string | Date;
}): void {
  const occurredAt = params.occurredAt ?? new Date();
  trackEvent('football_grid_match_found', params.userId, {
    match_id: params.matchId,
    mode: 'football_grid',
    variant: 'football_grid',
    search_id_prefix: idPrefix(params.searchId),
    origin: params.origin,
    opponent_type: params.opponentType,
    opponent_is_ai: params.opponentType === 'bot',
    queue_wait_ms: params.queueWaitMs ?? null,
    board_id: params.boardId,
    board_version: params.boardVersion,
    board_difficulty: params.boardDifficulty ?? null,
  }, {
    uuid: stableAnalyticsEventUuid(`football-grid:match-found:${params.matchId}:${params.userId}`),
    occurredAt,
  });
}

export function trackFootballGridMatchStarted(params: {
  userId: string;
  matchId: string;
  opponentType: 'human' | 'bot';
  boardId: string;
  boardVersion: number;
  boardDifficulty?: 'easy' | 'normal' | 'hard' | null;
  occurredAt: string | Date;
}): void {
  trackEvent('match_started', params.userId, {
    match_id: params.matchId,
    mode: 'football_grid',
    variant: 'football_grid',
    opponent_type: params.opponentType,
    opponent_is_ai: params.opponentType === 'bot',
    board_id: params.boardId,
    board_version: params.boardVersion,
    board_difficulty: params.boardDifficulty ?? null,
  }, {
    uuid: stableAnalyticsEventUuid(`football-grid:match-started:${params.matchId}:${params.userId}`),
    occurredAt: params.occurredAt,
  });
}

export interface TrackFootballGridMatchCompletedOptions {
  userId: string;
  matchId: string;
  origin: 'random' | 'challenge' | 'private' | 'public' | 'code';
  opponentType: 'human' | 'bot';
  result: 'win' | 'draw' | 'loss';
  completionReason: string;
  startedAt: string | Date;
  endedAt: string | Date;
  boardId: string;
  boardVersion: number;
  boardDifficulty: 'easy' | 'normal' | 'hard';
  turns: number;
  claimCount: number;
  correctAnswers: number;
  wrongAnswers: number;
  ambiguousAnswers: number;
  alreadyUsedAnswers: number;
  passes: number;
  noActionTimeouts: number;
  averageResponseMs: number | null;
  xpEarned: number;
  coinsEarned: number;
  tpEarned: number;
  coinEligibilityReason: string;
  tpEligibilityReason: string;
}

export function trackFootballGridMatchCompleted(
  params: TrackFootballGridMatchCompletedOptions,
): void {
  const startedAtMs = new Date(params.startedAt).getTime();
  const endedAtMs = new Date(params.endedAt).getTime();
  const durationMs = Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
    ? Math.max(0, endedAtMs - startedAtMs)
    : null;
  const noContest = params.completionReason === 'loading_no_show'
    || params.completionReason === 'simultaneous_disconnect'
    || params.completionReason === 'administrative_cancel';
  const eventName = noContest ? 'match_abandoned' : 'match_completed';
  trackEvent(eventName, params.userId, {
    match_id: params.matchId,
    mode: 'football_grid',
    variant: 'football_grid',
    origin: params.origin,
    opponent_type: params.opponentType,
    opponent_is_ai: params.opponentType === 'bot',
    result: params.result,
    won: params.result === 'win',
    is_draw: params.result === 'draw',
    completion_reason: params.completionReason,
    duration_ms: durationMs,
    duration_sec: durationMs === null ? null : durationMs / 1_000,
    board_id: params.boardId,
    board_version: params.boardVersion,
    board_difficulty: params.boardDifficulty,
    turns: Math.max(0, params.turns),
    claim_count: Math.max(0, params.claimCount),
    correct_answers: Math.max(0, params.correctAnswers),
    wrong_answers: Math.max(0, params.wrongAnswers),
    ambiguous_answers: Math.max(0, params.ambiguousAnswers),
    already_used_answers: Math.max(0, params.alreadyUsedAnswers),
    passes: Math.max(0, params.passes),
    no_action_timeouts: Math.max(0, params.noActionTimeouts),
    average_response_ms: params.averageResponseMs,
    xp_earned: Math.max(0, params.xpEarned),
    coins_earned: Math.max(0, params.coinsEarned),
    tp_earned: Math.max(0, params.tpEarned),
    coin_eligibility_reason: params.coinEligibilityReason,
    tp_eligibility_reason: params.tpEligibilityReason,
  }, {
    uuid: stableAnalyticsEventUuid(`football-grid:${eventName}:${params.matchId}:${params.userId}`),
    occurredAt: params.endedAt,
  });
}

export function trackFootballGridMissingAnswerReported(params: {
  userId: string;
  matchId: string;
  attemptId: string;
  boardId: string;
  cellIndex: number | null;
  attemptOutcome: string;
  occurredAt: string | Date;
}): void {
  trackEvent('football_grid_missing_answer_reported', params.userId, {
    match_id: params.matchId,
    board_id: params.boardId,
    attempt_id_prefix: idPrefix(params.attemptId),
    cell_index: params.cellIndex,
    attempt_outcome: params.attemptOutcome,
  }, {
    uuid: stableAnalyticsEventUuid(`football-grid:missing-answer:${params.attemptId}:${params.userId}`),
    occurredAt: params.occurredAt,
  });
}

export function trackFootballGridRematchResponse(params: {
  userId: string;
  matchId: string;
  seriesId: string;
  response: 'accepted' | 'declined';
  occurredAt: string | Date;
}): void {
  trackEvent('football_grid_rematch_response', params.userId, {
    match_id: params.matchId,
    series_id_prefix: idPrefix(params.seriesId),
    response: params.response,
  }, {
    uuid: stableAnalyticsEventUuid(`football-grid:rematch:${params.matchId}:${params.userId}:${params.response}`),
    occurredAt: params.occurredAt,
  });
}
