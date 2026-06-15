export function questionTimerKey(matchId: string, qIndex: number): string {
  return `${matchId}:${qIndex}`;
}

export function matchPresenceKey(matchId: string, userId: string): string {
  return `match:presence:${matchId}:${userId}`;
}

export function matchDisconnectKey(matchId: string, userId: string): string {
  return `match:disconnect:${matchId}:${userId}`;
}

export function matchExitPendingKey(matchId: string, userId: string): string {
  return `match:exit_pending:${matchId}:${userId}`;
}

export function matchPauseKey(matchId: string): string {
  return `match:pause:${matchId}`;
}

export function matchGraceKey(matchId: string): string {
  return `match:grace:${matchId}`;
}

export function matchResumeCountdownKey(matchId: string): string {
  return `match:resume_countdown:${matchId}`;
}

export function matchReconnectCountKey(matchId: string, userId: string): string {
  return `match:reconnect_count:${matchId}:${userId}`;
}

export function matchForfeitPendingUserKey(userId: string): string {
  return `user:match_forfeit_pending:${userId}`;
}

export function matchPartyDropoutPendingUserKey(userId: string): string {
  return `user:match_party_dropout_pending:${userId}`;
}

export function lastMatchKey(userId: string): string {
  return `user:last_match:${userId}`;
}

export function matchEnteredKey(matchId: string, userId: string): string {
  return `match:entered:${matchId}:${userId}`;
}

export function matchStagePresenceKey(matchId: string, stageKey: string, userId: string): string {
  return `match:stage_presence:${matchId}:${stageKey}:${userId}`;
}

export function matchStageReadyKey(matchId: string, stageKey: string, userId: string): string {
  return `match:stage_ready:${matchId}:${stageKey}:${userId}`;
}

/** Per-player Redis Set storing found answer group IDs during a countdown round. */
export function countdownPlayerKey(matchId: string, userId: string): string {
  return `match:cdown:${matchId}:${userId}`;
}
