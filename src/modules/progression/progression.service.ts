import { matchesRepo } from '../matches/matches.repo.js';
import { usersRepo } from '../users/users.repo.js';
import { getProgressionFromTotalXp, getMatchXpReward } from './progression.logic.js';
import { progressionRepo } from './progression.repo.js';

type WinnerDecisionMethod =
  | 'goals'
  | 'penalty_goals'
  | 'total_points'
  | 'total_points_fallback'
  | 'forfeit';

function getWinnerDecisionMethod(
  statePayload: Record<string, unknown> | null
): WinnerDecisionMethod | null {
  const raw = statePayload?.winnerDecisionMethod;
  return raw === 'goals'
    || raw === 'penalty_goals'
    || raw === 'total_points'
    || raw === 'total_points_fallback'
    || raw === 'forfeit'
    ? raw
    : null;
}

export const progressionService = {
  getProgression(totalXp: number) {
    return getProgressionFromTotalXp(totalXp);
  },

  async awardCompletedMatchXp(matchId: string): Promise<void> {
    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'completed' || match.is_dev) {
      return;
    }

    const players = await matchesRepo.listMatchPlayers(matchId);
    if (players.length === 0) {
      return;
    }

    const users = await Promise.all(players.map((player) => usersRepo.getById(player.user_id)));
    const humanPlayers = players.filter((_, index) => users[index] && !users[index]!.is_ai);
    if (humanPlayers.length === 0) {
      return;
    }

    const winnerDecisionMethod = getWinnerDecisionMethod(match.state_payload);
    const isForfeitDecision = winnerDecisionMethod === 'forfeit';
    const isHeadToHead = humanPlayers.length === 2;

    await progressionRepo.runInTransaction(async (tx) => {
      for (const player of humanPlayers) {
        const isDraw = match.winner_user_id === null;
        const isWinner = match.winner_user_id === player.user_id;
        const result: 'win' | 'loss' | 'draw' = isDraw ? 'draw' : isWinner ? 'win' : 'loss';
        const xpDelta = getMatchXpReward({
          mode: match.mode,
          result,
          isForfeitLoss: isHeadToHead && isForfeitDecision && result === 'loss',
        });

        await progressionRepo.grantXpInTx(tx, {
          userId: player.user_id,
          sourceType: 'match_result',
          sourceKey: match.id,
          xpDelta,
          metadata: {
            matchId: match.id,
            mode: match.mode,
            result,
            winnerDecisionMethod,
          },
        });
      }
    });
  },
};
