import { logger } from '../core/logger.js';
import type { PossessionStatePayload } from '../modules/matches/matches.service.js';
import { getUserIdBySeat, type ResolutionDecision } from './possession-state.js';

export function decideWinner(
  players: Array<{ user_id: string; seat: number; total_points: number }>,
  state: PossessionStatePayload
): ResolutionDecision {
  const seat1UserId = getUserIdBySeat(players, 1);
  const seat2UserId = getUserIdBySeat(players, 2);
  const fallbackWinnerId = seat1UserId ?? seat2UserId ?? players[0]?.user_id ?? null;

  if (state.goals.seat1 > state.goals.seat2) {
    return { winnerId: seat1UserId ?? fallbackWinnerId, method: 'goals', totalPointsFallbackUsed: false };
  }
  if (state.goals.seat2 > state.goals.seat1) {
    return { winnerId: seat2UserId ?? fallbackWinnerId, method: 'goals', totalPointsFallbackUsed: false };
  }

  if (state.penaltyGoals.seat1 > state.penaltyGoals.seat2) {
    return { winnerId: seat1UserId ?? fallbackWinnerId, method: 'penalty_goals', totalPointsFallbackUsed: false };
  }
  if (state.penaltyGoals.seat2 > state.penaltyGoals.seat1) {
    return { winnerId: seat2UserId ?? fallbackWinnerId, method: 'penalty_goals', totalPointsFallbackUsed: false };
  }

  const seat1Points = players.find((player) => player.seat === 1)?.total_points ?? 0;
  const seat2Points = players.find((player) => player.seat === 2)?.total_points ?? 0;

  if (seat1Points > seat2Points) {
    return { winnerId: seat1UserId ?? fallbackWinnerId, method: 'total_points_fallback', totalPointsFallbackUsed: true };
  }
  if (seat2Points > seat1Points) {
    return { winnerId: seat2UserId ?? fallbackWinnerId, method: 'total_points_fallback', totalPointsFallbackUsed: true };
  }

  logger.warn(
    {
      seat1Points,
      seat2Points,
      goals: state.goals,
      penaltyGoals: state.penaltyGoals,
    },
    'Possession winner fallback still tied on total points, selecting seat1 deterministically'
  );
  return { winnerId: fallbackWinnerId, method: 'total_points_fallback', totalPointsFallbackUsed: true };
}
