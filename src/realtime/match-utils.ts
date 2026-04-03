import type { MatchPlayerRow } from '../modules/matches/matches.types.js';
import type { MatchStandingPayload } from './socket.types.js';

/**
 * Increment the state version counter on any match state payload.
 * Handles non-finite values defensively (e.g. from JSON parse).
 */
export function bumpStateVersion(state: { stateVersionCounter: number }): void {
  const next = Number(state.stateVersionCounter);
  state.stateVersionCounter = Number.isFinite(next) ? next + 1 : 1;
}

export function buildStandings(players: MatchPlayerRow[]): MatchStandingPayload[] {
  const ordered = [...players].sort((a, b) => {
    if (b.total_points !== a.total_points) return b.total_points - a.total_points;
    if (b.correct_answers !== a.correct_answers) return b.correct_answers - a.correct_answers;

    const avgA = a.avg_time_ms ?? Number.MAX_SAFE_INTEGER;
    const avgB = b.avg_time_ms ?? Number.MAX_SAFE_INTEGER;
    if (avgA !== avgB) return avgA - avgB;

    return a.seat - b.seat;
  });

  return ordered.map((player, index) => ({
    userId: player.user_id,
    rank: index + 1,
    totalPoints: player.total_points,
    correctAnswers: player.correct_answers,
    avgTimeMs: player.avg_time_ms,
  }));
}
