/**
 * Pre-run profile snapshot + rollback for the burn-in engine.
 *
 * --execute requires a snapshot file: the exact pre-run ranked_profiles + XP
 * state for every roster bot, so a run can be fully reverted. Rollback:
 *   1. Consume the creation receipt (list of burn-in match ids).
 *   2. For each match, VERIFY it has ONLY roster-bot participants before
 *      touching it (never delete a match with a non-roster/human seat).
 *   3. Delete ledger rows, XP events, stats contributions, match rows.
 *   4. Restore each bot's ranked_profiles + total_xp from the snapshot.
 */
import { sql } from '../../src/db/index.js';
import type { BurnInBot, BurnInReceipt, BurnInSnapshot, ProfileSnapshotRow } from './types.js';

export async function snapshotProfiles(
  bots: BurnInBot[],
  meta: { seed: number; env: string; ceilingRp: number; humanTop10Rp: number | null; marginRp: number },
): Promise<BurnInSnapshot> {
  const userIds = bots.map((b) => b.userId);
  const rows = await sql<
    Array<{
      user_id: string;
      rp: number;
      tier: string;
      placement_status: string;
      placement_played: number;
      placement_wins: number;
      placement_seed_rp: number | null;
      placement_perf_sum: number;
      placement_points_for_sum: number;
      placement_points_against_sum: number;
      current_win_streak: number;
      last_ranked_match_at: string | null;
      total_xp: number;
    }>
  >`
    SELECT
      u.id AS user_id,
      rp.rp, rp.tier, rp.placement_status, rp.placement_played, rp.placement_wins,
      rp.placement_seed_rp, rp.placement_perf_sum, rp.placement_points_for_sum,
      rp.placement_points_against_sum, rp.current_win_streak, rp.last_ranked_match_at,
      u.total_xp
    FROM users u
    LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
    WHERE u.id = ANY(${userIds}::uuid[])
  `;

  const profiles: ProfileSnapshotRow[] = rows.map((r) => ({
    userId: r.user_id,
    rp: r.rp ?? 0,
    tier: r.tier ?? 'Academy',
    placementStatus: r.placement_status ?? 'unplaced',
    placementPlayed: r.placement_played ?? 0,
    placementWins: r.placement_wins ?? 0,
    placementSeedRp: r.placement_seed_rp ?? null,
    placementPerfSum: r.placement_perf_sum ?? 0,
    placementPointsForSum: r.placement_points_for_sum ?? 0,
    placementPointsAgainstSum: r.placement_points_against_sum ?? 0,
    currentWinStreak: r.current_win_streak ?? 0,
    lastRankedMatchAt: r.last_ranked_match_at ?? null,
    totalXp: Number(r.total_xp ?? 0),
    profileExisted: r.rp != null,
  }));

  return {
    createdAt: new Date().toISOString(),
    seed: meta.seed,
    env: meta.env,
    ceilingRp: meta.ceilingRp,
    humanTop10Rp: meta.humanTop10Rp,
    marginRp: meta.marginRp,
    profiles,
  };
}

export interface RollbackResult {
  matchesVerified: number;
  matchesDeleted: number;
  matchesRefused: string[];
  profilesRestored: number;
}

/**
 * Revert a burn-in run from its receipt + snapshot. Refuses to delete any match
 * whose participants are not ALL in the receipt's roster set.
 */
export async function rollback(receipt: BurnInReceipt, snapshot: BurnInSnapshot): Promise<RollbackResult> {
  const rosterSet = new Set(receipt.rosterUserIds);
  const matchesVerified: string[] = [];
  const matchesRefused: string[] = [];

  // Verify each match touches ONLY roster bots before any deletion.
  for (const matchId of receipt.matchIds) {
    const players = await sql<{ user_id: string }[]>`
      SELECT user_id FROM match_players WHERE match_id = ${matchId}
    `;
    if (players.length === 0) {
      // Already gone (partial prior rollback) — nothing to verify/delete.
      continue;
    }
    const allRoster = players.every((p) => rosterSet.has(p.user_id));
    if (allRoster) matchesVerified.push(matchId);
    else matchesRefused.push(matchId);
  }

  let matchesDeleted = 0;
  await sql.begin(async (tx) => {
    if (matchesVerified.length > 0) {
      // Ledger + XP events keyed by these matches, then the matches themselves
      // (match_players/match_answers cascade via FK ON DELETE CASCADE).
      await tx`DELETE FROM ranked_rp_changes WHERE match_id = ANY(${matchesVerified}::uuid[])`;
      await tx`DELETE FROM user_xp_events WHERE source_type = 'match_result' AND source_key = ANY(${matchesVerified})`;
      const deleted = await tx<{ id: string }[]>`
        DELETE FROM matches WHERE id = ANY(${matchesVerified}::uuid[]) RETURNING id
      `;
      matchesDeleted = deleted.length;
    }

    // Restore profiles + XP from the snapshot (authoritative pre-run state).
    for (const p of snapshot.profiles) {
      await tx`UPDATE users SET total_xp = ${p.totalXp} WHERE id = ${p.userId}`;
      if (p.profileExisted) {
        await tx`
          UPDATE ranked_profiles SET
            rp = ${p.rp}, tier = ${p.tier}, placement_status = ${p.placementStatus},
            placement_played = ${p.placementPlayed}, placement_wins = ${p.placementWins},
            placement_seed_rp = ${p.placementSeedRp}, placement_perf_sum = ${p.placementPerfSum},
            placement_points_for_sum = ${p.placementPointsForSum},
            placement_points_against_sum = ${p.placementPointsAgainstSum},
            current_win_streak = ${p.currentWinStreak},
            last_ranked_match_at = ${p.lastRankedMatchAt},
            updated_at = NOW()
          WHERE user_id = ${p.userId}
        `;
      } else {
        // Profile was created by the burn-in itself — remove it and its
        // user_mode_match_stats contribution to fully restore pre-run state.
        await tx`DELETE FROM ranked_profiles WHERE user_id = ${p.userId}`;
        await tx`DELETE FROM user_mode_match_stats WHERE user_id = ${p.userId} AND mode = 'ranked'`;
      }
    }

    // Clear the one-time marker so the env can be re-run after a rollback.
    await tx`DELETE FROM bot_model_params WHERE note = 'persistent-bot-burnin:complete'`;
  });

  return {
    matchesVerified: matchesVerified.length,
    matchesDeleted,
    matchesRefused,
    profilesRestored: snapshot.profiles.length,
  };
}
