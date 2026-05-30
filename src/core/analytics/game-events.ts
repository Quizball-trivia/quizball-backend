import { trackEvent } from '../analytics.js';

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
export function trackRankedQueueJoined(userId: string, rankPoints: number): void {
  trackEvent('ranked_queue_joined', userId, {
    rank_points: rankPoints,
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
export function trackSocketConnected(userId: string): void {
  trackEvent('socket_connected', userId, {
    connection_time: new Date().toISOString(),
  });
}

export function trackSocketDisconnected(
  userId: string,
  reason: string,
  durationMs: number
): void {
  trackEvent('socket_disconnected', userId, {
    reason,
    session_duration_ms: durationMs,
  });
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
