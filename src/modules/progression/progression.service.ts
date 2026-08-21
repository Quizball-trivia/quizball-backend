import { matchesRepo } from '../matches/matches.repo.js';
import { matchPlayersRepo } from '../matches/match-players.repo.js';
import { usersRepo } from '../users/users.repo.js';
import { isRankedSettleEligible } from '../users/ai-classification.js';
import { trackLevelUp } from '../../core/analytics/game-events.js';
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

  async awardCompletedMatchXp(matchId: string, occurredAt?: Date): Promise<void> {
    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'completed' || match.is_dev) {
      return;
    }
    // Football Grid owns XP settlement in its transactional outbox adapter.
    // Keeping the generic quiz progression path out prevents competing reward
    // semantics; the Grid ledger remains the sole idempotent writer.
    if (match.game_variant === 'football_grid') {
      return;
    }

    const players = await matchPlayersRepo.listMatchPlayers(matchId);
    if (players.length === 0) {
      return;
    }

    const usersById = await usersRepo.getByIds(players.map((player) => player.user_id));
    // XP/progression is in scope for persistent bots (they level like humans);
    // ephemeral/auction AI stay excluded. Single source of truth for eligibility.
    const xpEligiblePlayers = players.filter((player) => {
      const user = usersById.get(player.user_id);
      return user != null && isRankedSettleEligible(user);
    });
    if (xpEligiblePlayers.length === 0) {
      return;
    }

    const winnerDecisionMethod = getWinnerDecisionMethod(match.state_payload);
    const isForfeitDecision = winnerDecisionMethod === 'forfeit';
    const isHeadToHead = xpEligiblePlayers.length === 2;

    await progressionRepo.runInTransaction(async (tx) => {
      for (const player of xpEligiblePlayers) {
        const isDraw = match.winner_user_id === null;
        const isWinner = match.winner_user_id === player.user_id;
        const result: 'win' | 'loss' | 'draw' = isDraw ? 'draw' : isWinner ? 'win' : 'loss';
        const xpDelta = getMatchXpReward({
          mode: match.mode,
          result,
          isForfeitLoss: isHeadToHead && isForfeitDecision && result === 'loss',
        });

        const grantResult = await progressionRepo.grantXpInTx(tx, {
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
          occurredAt,
        });

        if (grantResult.awarded) {
          const oldLevel = getProgressionFromTotalXp(grantResult.totalXp - xpDelta).level;
          const newLevel = getProgressionFromTotalXp(grantResult.totalXp).level;
          // Level-up analytics stay human-only (capability matrix); bots grant XP
          // silently.
          const isBot = usersById.get(player.user_id)?.is_ai === true;
          if (newLevel > oldLevel && !isBot) {
            trackLevelUp(player.user_id, newLevel);
          }
        }
      }
    });
  },
};
