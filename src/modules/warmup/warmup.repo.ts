import { sql } from '../../db/index.js';

interface WarmupPlayerBestRow {
  user_id: string;
  best_score: number;
  total_games: number;
}

interface WarmupPairBestRow {
  user_a_id: string;
  user_b_id: string;
  best_score: number;
  total_games: number;
}

/** Sort two UUIDs so user_a < user_b (matches CHECK constraint). */
function sortPair(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA];
}

export const warmupRepo = {
  async getPlayerBest(userId: string): Promise<WarmupPlayerBestRow | null> {
    try {
      const [row] = await sql<WarmupPlayerBestRow[]>`
        SELECT * FROM warmup_player_bests
        WHERE user_id::text = ${userId}
      `;
      return row ?? null;
    } catch (error) {
      const pgCode = (error as { code?: string })?.code;
      if (pgCode === '42883') {
        return null;
      }
      throw error;
    }
  },

  async getPairBest(userAId: string, userBId: string): Promise<WarmupPairBestRow | null> {
    const [a, b] = sortPair(userAId, userBId);
    try {
      const [row] = await sql<WarmupPairBestRow[]>`
        SELECT * FROM warmup_pair_bests
        WHERE user_a_id::text = ${a}
          AND user_b_id::text = ${b}
      `;
      return row ?? null;
    } catch (error) {
      const pgCode = (error as { code?: string })?.code;
      // Backward-compat for environments where pair table/check was created with invalid UUID operator.
      if (pgCode === '42883') {
        return null;
      }
      throw error;
    }
  },

  async saveScore(
    userIds: [string, string],
    score: number
  ): Promise<{
    playerBests: Record<string, number>;
    pairBest: number;
    isNewPlayerBest: Record<string, boolean>;
    isNewPairBest: boolean;
  }> {
    const playerBests: Record<string, number> = {};
    const isNewPlayerBest: Record<string, boolean> = {};

    // UPSERT both player bests
    for (const userId of userIds) {
      const [row] = await sql<WarmupPlayerBestRow[]>`
        INSERT INTO warmup_player_bests (user_id, best_score, total_games, updated_at)
        VALUES (${userId}::uuid, ${score}, 1, now())
        ON CONFLICT (user_id) DO UPDATE SET
          best_score = GREATEST(warmup_player_bests.best_score, ${score}),
          total_games = warmup_player_bests.total_games + 1,
          updated_at = now()
        RETURNING *
      `;
      playerBests[userId] = row.best_score;
      isNewPlayerBest[userId] = row.best_score === score && row.total_games >= 1;
    }

    // UPSERT pair best with JS-sorted canonicalization
    const [a, b] = sortPair(userIds[0], userIds[1]);
    const [pairRow] = await sql<WarmupPairBestRow[]>`
      INSERT INTO warmup_pair_bests (user_a_id, user_b_id, best_score, total_games, updated_at)
      VALUES (${a}::uuid, ${b}::uuid, ${score}, 1, now())
      ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
        best_score = GREATEST(warmup_pair_bests.best_score, ${score}),
        total_games = warmup_pair_bests.total_games + 1,
        updated_at = now()
      RETURNING *
    `;

    return {
      playerBests,
      pairBest: pairRow.best_score,
      isNewPlayerBest,
      isNewPairBest: pairRow.best_score === score && pairRow.total_games >= 1,
    };
  },
};
