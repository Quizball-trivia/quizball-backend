export function questionTimerKey(matchId: string, qIndex: number): string {
  return `${matchId}:${qIndex}`;
}

export function matchPresenceKey(matchId: string, userId: string): string {
  return `match:presence:${matchId}:${userId}`;
}

export function matchDisconnectKey(matchId: string, userId: string): string {
  return `match:disconnect:${matchId}:${userId}`;
}

export function matchPauseKey(matchId: string): string {
  return `match:pause:${matchId}`;
}

export function matchGraceKey(matchId: string): string {
  return `match:grace:${matchId}`;
}

export function matchReconnectCountKey(matchId: string, userId: string): string {
  return `match:reconnect_count:${matchId}:${userId}`;
}

export function lastMatchKey(userId: string): string {
  return `user:last_match:${userId}`;
}
