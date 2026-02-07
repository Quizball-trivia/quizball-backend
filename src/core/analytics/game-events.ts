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

export function trackMatchCompleted(
  userId: string,
  matchId: string,
  mode: string,
  won: boolean,
  score: number,
  opponentScore: number,
  durationMs: number
): void {
  trackEvent('match_completed', userId, {
    match_id: matchId,
    mode,
    won,
    score,
    opponent_score: opponentScore,
    duration_ms: durationMs,
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
  context?: Record<string, any>
): void {
  trackEvent('error_occurred', userId || 'anonymous', {
    error_code: errorCode,
    error_message: errorMessage,
    ...context,
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
