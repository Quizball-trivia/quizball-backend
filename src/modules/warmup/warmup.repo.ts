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
    playerOldBests: Record<string, number | null>;
    pairBest: number;
    pairOldBest: number | null;
  }> {
    return sql.begin(async (tx) => {
      const playerBests: Record<string, number> = {};
      const playerOldBests: Record<string, number | null> = {};

      // UPSERT both player bests
      for (const userId of userIds) {
        const [row] = await tx.unsafe<(WarmupPlayerBestRow & { old_best_score: number | null })[]>(
          `WITH old_record AS (
             SELECT best_score AS old_best_score
             FROM warmup_player_bests
             WHERE user_id = $1::uuid
           )
           INSERT INTO warmup_player_bests (user_id, best_score, total_games, updated_at)
           VALUES ($1::uuid, $2, 1, now())
           ON CONFLICT (user_id) DO UPDATE SET
             best_score = GREATEST(warmup_player_bests.best_score, $2),
             total_games = warmup_player_bests.total_games + 1,
             updated_at = now()
           RETURNING *, (SELECT old_best_score FROM old_record) AS old_best_score`,
          [userId, score]
        );
        playerBests[userId] = row.best_score;
        playerOldBests[userId] = row.old_best_score;
      }

      // UPSERT pair best with JS-sorted canonicalization
      // Use a CTE to capture the old best_score before the update
      const [a, b] = sortPair(userIds[0], userIds[1]);
      const [pairRow] = await tx.unsafe<(
        WarmupPairBestRow & { old_best_score: number | null }
      )[]>(
        `WITH old_record AS (
           SELECT best_score AS old_best_score
           FROM warmup_pair_bests
           WHERE user_a_id = $1::uuid AND user_b_id = $2::uuid
         )
         INSERT INTO warmup_pair_bests (user_a_id, user_b_id, best_score, total_games, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 1, now())
         ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
           best_score = GREATEST(warmup_pair_bests.best_score, $3),
           total_games = warmup_pair_bests.total_games + 1,
           updated_at = now()
         RETURNING *, (SELECT old_best_score FROM old_record) AS old_best_score`,
        [a, b, score]
      );

      return {
        playerBests,
        playerOldBests,
        pairBest: pairRow.best_score,
        pairOldBest: pairRow.old_best_score,
      };
    });
  },
};
