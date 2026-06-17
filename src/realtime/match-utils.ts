import type { I18nField } from '../db/types.js';
import type { MatchPlayerRow } from '../modules/matches/matches.types.js';
import type { MatchStandingPayload } from './socket.types.js';

/**
 * Normalize a persisted category name into the i18n object shape. Matches drafted
 * after the i18n change store `{ en, ka }`; older cached/persisted matches stored a
 * collapsed string. Returns null for anything unusable so the caller can skip it.
 */
export function normalizeI18nName(value: unknown): I18nField | null {
  if (typeof value === 'string') {
    return value.length > 0 ? { en: value } : null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0
    );
    return entries.length > 0 ? Object.fromEntries(entries) : null;
  }
  return null;
}

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
