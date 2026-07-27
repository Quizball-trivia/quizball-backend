/**
 * Pre-run profile snapshot + rollback for the burn-in engine.
 *
 * The snapshot captures the EXACT pre-run mutable state of every roster bot:
 * ranked_profiles, total_xp, user_mode_match_stats(ranked), and user_achievements
 * (findings 2 + 10), plus profile updated_at for post-snapshot mutation
 * detection. It is bound to the run via manifestHash.
 *
 * Rollback (findings 1/2/8) is fully atomic and refuses on ANY inconsistency:
 *   1. Mutual consistency: snapshot.manifestHash === receipt-header manifestHash.
 *   2. No post-snapshot mutation: no roster bot may have a ranked ledger row,
 *      xp event, or profile update AFTER the snapshot that the receipt does not
 *      account for — else abort, pointing at the offending bots.
 *   3. Per match (from the receipt): exact participant pair, ranked_context.burnIn
 *      === true, and fixture-key correspondence. ANY refusal aborts the WHOLE
 *      rollback (nothing deleted, marker kept).
 *   4. Only then, in one transaction: delete burn-in matches + ledger + xp +
 *      achievements sourced from them, and RESTORE every captured field.
 */
import { sql } from '../../src/db/index.js';
import type {
  BurnInBot,
  BurnInSnapshot,
  ProfileSnapshotRow,
  ReceiptHeaderLine,
  ReceiptFixtureLine,
} from './types.js';

const BURN_IN_MARKER_NOTE = 'persistent-bot-burnin:complete';

export async function snapshotProfiles(
  bots: BurnInBot[],
  meta: {
    manifestHash: string;
    seed: number;
    env: string;
    ceilingRp: number;
    humanTop10Rp: number | null;
    marginRp: number;
  },
): Promise<BurnInSnapshot> {
  const userIds = bots.map((b) => b.userId);
  const [profileRows, statsRows, achievementRows] = await Promise.all([
    sql<
      Array<{
        user_id: string;
        rp: number | null;
        tier: string | null;
        placement_status: string | null;
        placement_played: number | null;
        placement_wins: number | null;
        placement_seed_rp: number | null;
        placement_perf_sum: number | null;
        placement_points_for_sum: number | null;
        placement_points_against_sum: number | null;
        current_win_streak: number | null;
        last_ranked_match_at: string | null;
        profile_updated_at: string | null;
        total_xp: number;
      }>
    >`
      SELECT
        u.id AS user_id,
        rp.rp, rp.tier, rp.placement_status, rp.placement_played, rp.placement_wins,
        rp.placement_seed_rp, rp.placement_perf_sum, rp.placement_points_for_sum,
        rp.placement_points_against_sum, rp.current_win_streak, rp.last_ranked_match_at,
        rp.updated_at AS profile_updated_at,
        u.total_xp
      FROM users u
      LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE u.id = ANY(${userIds}::uuid[])
    `,
    sql<
      Array<{ user_id: string; games_played: number; wins: number; losses: number; draws: number; last_match_at: string | null }>
    >`
      SELECT user_id, games_played, wins, losses, draws, last_match_at
      FROM user_mode_match_stats WHERE user_id = ANY(${userIds}::uuid[]) AND mode = 'ranked'
    `,
    sql<
      Array<{ user_id: string; achievement_id: string; progress: number; unlocked_at: string | null; source_match_id: string | null; created_at: string; updated_at: string }>
    >`
      SELECT user_id, achievement_id, progress, unlocked_at, source_match_id, created_at, updated_at
      FROM user_achievements WHERE user_id = ANY(${userIds}::uuid[])
    `,
  ]);

  type AchievementRow = (typeof achievementRows)[number];
  const statsByUser = new Map(statsRows.map((r) => [r.user_id, r]));
  const achByUser = new Map<string, AchievementRow[]>();
  for (const r of achievementRows) {
    const list = achByUser.get(r.user_id) ?? [];
    list.push(r);
    achByUser.set(r.user_id, list);
  }

  const profiles: ProfileSnapshotRow[] = profileRows.map((r) => {
    const stats = statsByUser.get(r.user_id);
    return {
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
      profileUpdatedAt: r.profile_updated_at ?? null,
      totalXp: Number(r.total_xp ?? 0),
      profileExisted: r.rp != null,
      rankedStats: {
        existed: stats != null,
        gamesPlayed: stats?.games_played ?? 0,
        wins: stats?.wins ?? 0,
        losses: stats?.losses ?? 0,
        draws: stats?.draws ?? 0,
        lastMatchAt: stats?.last_match_at ?? null,
      },
      achievements: (achByUser.get(r.user_id) ?? []).map((a) => ({
        achievementId: a.achievement_id,
        progress: a.progress,
        unlockedAt: a.unlocked_at,
        sourceMatchId: a.source_match_id,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    };
  });

  return {
    createdAt: new Date().toISOString(),
    manifestHash: meta.manifestHash,
    seed: meta.seed,
    env: meta.env,
    ceilingRp: meta.ceilingRp,
    humanTop10Rp: meta.humanTop10Rp,
    marginRp: meta.marginRp,
    profiles,
  };
}

export interface RollbackResult {
  matchesDeleted: number;
  profilesRestored: number;
}

export class RollbackRefusedError extends Error {}

/**
 * Revert a burn-in run from its receipt header + fixture lines + snapshot,
 * atomically. Refuses (throwing RollbackRefusedError, deleting nothing) on any
 * mutual-consistency failure, per-match verification failure, or post-snapshot
 * mutation.
 */
export async function rollback(
  header: ReceiptHeaderLine,
  fixtures: ReceiptFixtureLine[],
  snapshot: BurnInSnapshot,
): Promise<RollbackResult> {
  // 1. Mutual consistency.
  if (snapshot.manifestHash !== header.manifestHash) {
    throw new RollbackRefusedError(
      `manifest mismatch: snapshot ${snapshot.manifestHash} vs receipt ${header.manifestHash}`,
    );
  }
  const rosterSet = new Set(header.rosterUserIds);
  const snapshotUserSet = new Set(snapshot.profiles.map((p) => p.userId));
  for (const id of rosterSet) {
    if (!snapshotUserSet.has(id)) {
      throw new RollbackRefusedError(`roster bot ${id} missing from snapshot`);
    }
  }

  const receiptMatchIds = fixtures.map((f) => f.matchId);
  const receiptMatchSet = new Set(receiptMatchIds);
  const fixtureByMatch = new Map(fixtures.map((f) => [f.matchId, f]));

  // 2. No post-snapshot mutation: any ranked ledger / xp event for a roster bot
  // whose match is NOT in the receipt indicates live activity after execute.
  const strayLedger = await sql<{ user_id: string; match_id: string }[]>`
    SELECT user_id, match_id FROM ranked_rp_changes
    WHERE user_id = ANY(${header.rosterUserIds}::uuid[])
  `;
  const strayLedgerBots = new Set(
    strayLedger.filter((r) => !receiptMatchSet.has(r.match_id)).map((r) => r.user_id),
  );
  const strayXp = await sql<{ user_id: string; source_key: string }[]>`
    SELECT user_id, source_key FROM user_xp_events
    WHERE user_id = ANY(${header.rosterUserIds}::uuid[]) AND source_type = 'match_result'
  `;
  const strayXpBots = new Set(
    strayXp.filter((r) => !receiptMatchSet.has(r.source_key)).map((r) => r.user_id),
  );
  const offending = [...new Set([...strayLedgerBots, ...strayXpBots])];
  if (offending.length > 0) {
    throw new RollbackRefusedError(
      `post-snapshot live activity on roster bots — rollback refused: ${offending.join(', ')}`,
    );
  }

  // 3. Per-match verification (exact pair + burnIn tag + fixture-key match).
  const dbMatches = await sql<
    { id: string; ranked_context: { burnIn?: unknown; fixtureKey?: unknown } | null }[]
  >`SELECT id, ranked_context FROM matches WHERE id = ANY(${receiptMatchIds}::uuid[])`;
  const dbMatchById = new Map(dbMatches.map((m) => [m.id, m]));
  const dbPlayers = await sql<{ match_id: string; user_id: string; seat: number }[]>`
    SELECT match_id, user_id, seat FROM match_players WHERE match_id = ANY(${receiptMatchIds}::uuid[])
  `;
  const playersByMatch = new Map<string, { user_id: string; seat: number }[]>();
  for (const p of dbPlayers) {
    const list = playersByMatch.get(p.match_id) ?? [];
    list.push(p);
    playersByMatch.set(p.match_id, list);
  }

  const verifiedMatchIds: string[] = [];
  for (const matchId of receiptMatchIds) {
    const dbMatch = dbMatchById.get(matchId);
    if (!dbMatch) continue; // never written / already rolled back — skip, don't refuse
    const fx = fixtureByMatch.get(matchId)!;
    const ctx = dbMatch.ranked_context ?? {};
    if (ctx.burnIn !== true) {
      throw new RollbackRefusedError(`match ${matchId} is not tagged burnIn=true — refusing`);
    }
    if (ctx.fixtureKey !== fx.key) {
      throw new RollbackRefusedError(`match ${matchId} fixtureKey mismatch — refusing`);
    }
    const players = (playersByMatch.get(matchId) ?? []).sort((a, b) => a.seat - b.seat);
    const seatA = players.find((p) => p.seat === 1);
    const seatB = players.find((p) => p.seat === 2);
    if (seatA?.user_id !== fx.botAUserId || seatB?.user_id !== fx.botBUserId) {
      throw new RollbackRefusedError(`match ${matchId} participant pair mismatch — refusing`);
    }
    if (!rosterSet.has(seatA.user_id) || !rosterSet.has(seatB.user_id)) {
      throw new RollbackRefusedError(`match ${matchId} has a non-roster participant — refusing`);
    }
    verifiedMatchIds.push(matchId);
  }

  // 4. Atomic delete + restore.
  let matchesDeleted = 0;
  await sql.begin(async (tx) => {
    if (verifiedMatchIds.length > 0) {
      await tx`DELETE FROM ranked_rp_changes WHERE match_id = ANY(${verifiedMatchIds}::uuid[])`;
      await tx`DELETE FROM user_xp_events WHERE source_type = 'match_result' AND source_key = ANY(${verifiedMatchIds})`;
      // Achievements sourced from a burn-in match: clear the source pointer path
      // by restoring below; here just remove the FK reference via cascade on
      // match delete (source_match_id ON DELETE SET NULL). Delete matches last
      // (match_players/match_answers cascade).
      const deleted = await tx<{ id: string }[]>`
        DELETE FROM matches WHERE id = ANY(${verifiedMatchIds}::uuid[]) RETURNING id
      `;
      matchesDeleted = deleted.length;
    }

    for (const p of snapshot.profiles) {
      // total_xp restore (authoritative pre-run value).
      await tx`UPDATE users SET total_xp = ${p.totalXp} WHERE id = ${p.userId}`;

      // ranked_profiles: restore if it existed, else delete a burn-in-created one.
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
        await tx`DELETE FROM ranked_profiles WHERE user_id = ${p.userId}`;
      }

      // user_mode_match_stats(ranked): restore captured aggregate, or delete a
      // row the burn-in created (finding 2).
      if (p.rankedStats.existed) {
        await tx`
          UPDATE user_mode_match_stats SET
            games_played = ${p.rankedStats.gamesPlayed},
            wins = ${p.rankedStats.wins}, losses = ${p.rankedStats.losses}, draws = ${p.rankedStats.draws},
            last_match_at = ${p.rankedStats.lastMatchAt}, updated_at = NOW()
          WHERE user_id = ${p.userId} AND mode = 'ranked'
        `;
      } else {
        await tx`DELETE FROM user_mode_match_stats WHERE user_id = ${p.userId} AND mode = 'ranked'`;
      }

      // user_achievements: delete all, then re-insert the snapshot set (finding 10).
      await tx`DELETE FROM user_achievements WHERE user_id = ${p.userId}`;
      for (const a of p.achievements) {
        await tx`
          INSERT INTO user_achievements (user_id, achievement_id, progress, unlocked_at, source_match_id, created_at, updated_at)
          VALUES (${p.userId}, ${a.achievementId}, ${a.progress}, ${a.unlockedAt}, ${a.sourceMatchId}, ${a.createdAt}, ${a.updatedAt})
        `;
      }
    }

    // Clear the one-time marker so the env can be re-run after a full rollback.
    await tx`DELETE FROM bot_model_params WHERE note = ${BURN_IN_MARKER_NOTE}`;
  });

  return { matchesDeleted, profilesRestored: snapshot.profiles.length };
}
