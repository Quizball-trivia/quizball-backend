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

export function trackStaleLobbyHealed(params: {
  userId: string;
  lobbyId: string;
  mode: string;
  gameMode: string;
  idleMs: number;
}): void {
  trackEvent('stale_lobby_healed', params.userId, {
    lobby_id: params.lobbyId,
    mode: params.mode,
    game_mode: params.gameMode,
    idle_ms: params.idleMs,
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

// ── Auction (3-seat bidding mode) ────────────────────────────────────────────
// Auction shipped to production with no analytics at all, so the mode was
// invisible in PostHog while ranked, friendly, daily challenges and even
// Football Grid had funnel coverage. These mirror the Football Grid shape:
// the canonical `match_started` / `match_completed` names carrying
// `mode: 'auction'` (so auction lands in the existing cross-mode dashboards)
// plus one auction-specific pre-match event.
//
// Emitted per HUMAN seat only. Bot seats have synthetic `is_ai` user ids that
// would inflate person counts, so bot presence travels as a property
// (`bot_count` / `opponent_is_ai`) rather than as extra actors. `trackEvent`
// also drops known AI distinct ids, but skipping them at the call site keeps
// the intent explicit and saves the lookup.

export type AuctionAnalyticsOrigin = 'queue' | 'lobby';

/** Auction profit/value figures are reconstructed from match state and can be
 *  NaN on a state that predates a scoring field. Never ship NaN to PostHog —
 *  it lands as a string and poisons numeric aggregations. */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function durationMsBetween(
  startedAt: string | Date,
  endedAt: string | Date,
): number | null {
  const startedAtMs = new Date(startedAt).getTime();
  const endedAtMs = new Date(endedAt).getTime();
  return Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
    ? Math.max(0, endedAtMs - startedAtMs)
    : null;
}

export function trackAuctionMatchFound(params: {
  userId: string;
  matchId: string;
  humanCount: number;
  botCount: number;
  locale: 'en' | 'ka' | 'es';
  formation: string;
  occurredAt?: string | Date;
}): void {
  const occurredAt = params.occurredAt ?? new Date();
  trackEvent('auction_match_found', params.userId, {
    match_id: params.matchId,
    mode: 'auction',
    variant: 'auction',
    human_count: params.humanCount,
    bot_count: params.botCount,
    opponent_is_ai: params.botCount > 0,
    locale: params.locale,
    formation: params.formation,
  }, {
    uuid: stableAnalyticsEventUuid(`auction:match-found:${params.matchId}:${params.userId}`),
    occurredAt,
  });
}

export function trackAuctionMatchStarted(params: {
  userId: string;
  matchId: string;
  origin: AuctionAnalyticsOrigin;
  humanCount: number;
  botCount: number;
  locale: 'en' | 'ka' | 'es';
  formation: string;
  occurredAt: string | Date;
}): void {
  trackEvent('match_started', params.userId, {
    match_id: params.matchId,
    mode: 'auction',
    variant: 'auction',
    origin: params.origin,
    human_count: params.humanCount,
    bot_count: params.botCount,
    opponent_is_ai: params.botCount > 0,
    locale: params.locale,
    formation: params.formation,
  }, {
    uuid: stableAnalyticsEventUuid(`auction:match-started:${params.matchId}:${params.userId}`),
    occurredAt: params.occurredAt,
  });
}

export interface TrackAuctionMatchCompletedOptions {
  userId: string;
  matchId: string;
  origin: AuctionAnalyticsOrigin;
  /** 1 = winner. Ties share a rank, so placement is not always unique. */
  placement: number;
  seatCount: number;
  humanCount: number;
  botCount: number;
  /** Squad value minus spend. Can be negative; NaN on legacy state. */
  profit: number;
  /** Profit scaled by chemistry — the figure seats are actually ranked on. */
  adjustedProfit: number;
  chemistry: number;
  totalTrueValue: number;
  budgetRemaining: number;
  squadComplete: boolean;
  forfeited: boolean;
  roundsPlayed: number;
  coinsEarned: number;
  /** null when the match awards no Auction Points at all (friendly/lobby). */
  auctionPointsEarned: number | null;
  startedAt: string | Date;
  endedAt: string | Date;
}

export function trackAuctionMatchCompleted(
  params: TrackAuctionMatchCompletedOptions,
): void {
  const durationMs = durationMsBetween(params.startedAt, params.endedAt);
  trackEvent('match_completed', params.userId, {
    match_id: params.matchId,
    mode: 'auction',
    variant: 'auction',
    origin: params.origin,
    placement: params.placement,
    won: params.placement === 1,
    seat_count: params.seatCount,
    human_count: params.humanCount,
    bot_count: params.botCount,
    opponent_is_ai: params.botCount > 0,
    profit: finiteOrNull(params.profit),
    adjusted_profit: finiteOrNull(params.adjustedProfit),
    chemistry: finiteOrNull(params.chemistry),
    total_true_value: finiteOrNull(params.totalTrueValue),
    budget_remaining: finiteOrNull(params.budgetRemaining),
    squad_complete: params.squadComplete,
    forfeited: params.forfeited,
    rounds_played: params.roundsPlayed,
    coins_earned: params.coinsEarned,
    auction_points_earned: params.auctionPointsEarned,
    duration_ms: durationMs,
    duration_sec: durationMs === null ? null : durationMs / 1_000,
  }, {
    uuid: stableAnalyticsEventUuid(`auction:match-completed:${params.matchId}:${params.userId}`),
    occurredAt: params.endedAt,
  });
}
