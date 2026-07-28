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
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sql } from '../../src/db/index.js';
import type {
  BurnInBot,
  BurnInSnapshot,
  ProfileSnapshotRow,
  ReceiptHeaderLine,
  ReceiptFixtureLine,
} from './types.js';

const BURN_IN_MARKER_NOTE = 'persistent-bot-burnin:complete';

/** SHA-256 over the canonical snapshot body (everything except integrityHash). */
function snapshotIntegrityHash(snapshot: Omit<BurnInSnapshot, 'integrityHash'>): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

/**
 * Write the snapshot WRITE-ONCE via an exclusive create ('wx'): if the file
 * already exists the OS refuses (EEXIST) and we abort — no silent overwrite of a
 * prior run's snapshot (finding 2). Stamps an integrity hash into the file.
 */
export function writeSnapshotExclusive(path: string, snapshot: BurnInSnapshot): void {
  const withHash: BurnInSnapshot = { ...snapshot, integrityHash: snapshotIntegrityHash({ ...snapshot, integrityHash: undefined }) };
  try {
    writeFileSync(path, JSON.stringify(withHash, null, 2), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing snapshot ${path} (write-once). Roll back or use a fresh path.`);
    }
    throw err;
  }
}

/** Read + integrity-verify a snapshot file. Throws on tamper/corruption. */
export function readSnapshot(path: string): BurnInSnapshot {
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as BurnInSnapshot;
  const expected = snapshot.integrityHash;
  const actual = snapshotIntegrityHash({ ...snapshot, integrityHash: undefined });
  if (expected !== actual) {
    throw new Error(`Snapshot ${path} failed integrity check (expected ${expected}, got ${actual}) — refusing.`);
  }
  return snapshot;
}

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
  // ── Pre-tx mutual consistency (cheap, no DB) ───────────────────────────────
  if (snapshot.manifestHash !== header.manifestHash) {
    throw new RollbackRefusedError(`manifest mismatch: snapshot ${snapshot.manifestHash} vs receipt ${header.manifestHash}`);
  }
  const rosterSet = new Set(header.rosterUserIds);
  const snapshotUserSet = new Set(snapshot.profiles.map((p) => p.userId));
  for (const id of rosterSet) {
    if (!snapshotUserSet.has(id)) throw new RollbackRefusedError(`roster bot ${id} missing from snapshot`);
  }
  // Restore must cover EXACTLY the receipt roster — reject snapshot users beyond it.
  for (const p of snapshot.profiles) {
    if (!rosterSet.has(p.userId)) throw new RollbackRefusedError(`snapshot user ${p.userId} is outside the receipt roster — refusing`);
  }

  const receiptMatchIds = fixtures.map((f) => f.matchId);
  const receiptMatchSet = new Set(receiptMatchIds);
  const fixtureByMatch = new Map(fixtures.map((f) => [f.matchId, f]));
  const snapshotByUser = new Map(snapshot.profiles.map((p) => [p.userId, p]));

  // Everything below — validation AND restore — happens in ONE transaction with
  // the roster bots' profiles row-locked (FOR UPDATE), so a live completion
  // cannot race between the checks and the restore. RollbackRefusedError aborts
  // the tx: nothing is deleted, the marker is kept.
  let matchesDeleted = 0;
  try {
    await sql.begin(async (tx) => {
      // Lock EVERY mutated table's roster rows FOR UPDATE for the whole tx, so
      // no XP / achievement / stats / profile write can race in between the
      // validation and the restore (P1-2).
      await tx`SELECT user_id FROM ranked_profiles WHERE user_id = ANY(${header.rosterUserIds}::uuid[]) FOR UPDATE`;
      await tx`SELECT user_id FROM user_mode_match_stats WHERE user_id = ANY(${header.rosterUserIds}::uuid[]) FOR UPDATE`;
      await tx`SELECT user_id FROM user_achievements WHERE user_id = ANY(${header.rosterUserIds}::uuid[]) FOR UPDATE`;
      await tx`SELECT user_id FROM user_xp_events WHERE user_id = ANY(${header.rosterUserIds}::uuid[]) FOR UPDATE`;
      await tx`SELECT id FROM users WHERE id = ANY(${header.rosterUserIds}::uuid[]) FOR UPDATE`;

      // 1. No post-snapshot mutation on ANY tracked surface.
      const strayLedger = await tx<{ user_id: string; match_id: string }[]>`
        SELECT user_id, match_id FROM ranked_rp_changes WHERE user_id = ANY(${header.rosterUserIds}::uuid[])
      `;
      const strayXp = await tx<{ user_id: string; source_type: string; source_key: string }[]>`
        SELECT user_id, source_type, source_key FROM user_xp_events WHERE user_id = ANY(${header.rosterUserIds}::uuid[])
      `;
      const offending = new Set<string>();
      const reasons: string[] = [];
      const flag = (userId: string, why: string) => { offending.add(userId); reasons.push(`${userId}: ${why}`); };
      for (const r of strayLedger) if (!receiptMatchSet.has(r.match_id)) flag(r.user_id, `ledger for non-receipt match ${r.match_id}`);
      for (const r of strayXp) {
        if (r.source_type === 'match_result') { if (!receiptMatchSet.has(r.source_key)) flag(r.user_id, `xp for non-receipt match ${r.source_key}`); }
        else flag(r.user_id, `non-match xp (${r.source_type})`);
      }

      // profile_updated_at drift: compare the LIVE updated_at against the value
      // captured in the snapshot (P1-2 — the captured-but-unused field, now used).
      const nowProfiles = await tx<{ user_id: string; updated_at: string | null; exists: boolean }[]>`
        SELECT u.id AS user_id, rp.updated_at, (rp.user_id IS NOT NULL) AS exists
        FROM users u LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
        WHERE u.id = ANY(${header.rosterUserIds}::uuid[])
      `;
      const verifiedMatchSet = receiptMatchSet; // updated_at moved by OUR fixtures is expected
      for (const r of nowProfiles) {
        const snap = snapshotByUser.get(r.user_id);
        if (!snap) continue;
        if (snap.profileExisted && !r.exists) { flag(r.user_id, 'profile row vanished'); continue; }
        if (!snap.profileExisted && r.exists) continue; // burn-in-created; removed in restore
        // If updated_at advanced past the snapshot AND the bot has NO burn-in
        // ledger row (i.e. our own fixtures did not touch it), a live write moved
        // it. A bot our fixtures settled legitimately has updated_at moved — but
        // that is always accompanied by a receipt ledger row, checked above; a
        // MOVE with no receipt ledger is live drift.
        const movedPastSnapshot = snap.profileUpdatedAt != null && r.updated_at != null
          && new Date(r.updated_at).getTime() > new Date(snap.profileUpdatedAt).getTime();
        const hasReceiptLedger = strayLedger.some((l) => l.user_id === r.user_id && verifiedMatchSet.has(l.match_id));
        if (movedPastSnapshot && !hasReceiptLedger) flag(r.user_id, `profile updated_at advanced with no burn-in ledger`);
      }

      // Achievement drift: an achievement whose source_match_id points to a
      // match OUTSIDE the receipt is a live unlock → abort. (A burn-in fixture
      // unlock has source in the receipt, or a NULL source when the row was a
      // progress-then-unlock update — either way the ledger/xp checks above
      // already flag any accompanying live match, so a NULL source that is not
      // in the snapshot is safely burn-in-created and removed in restore.)
      const nowAch = await tx<{ user_id: string; achievement_id: string; source_match_id: string | null }[]>`
        SELECT user_id, achievement_id, source_match_id FROM user_achievements WHERE user_id = ANY(${header.rosterUserIds}::uuid[])
      `;
      for (const a of nowAch) {
        const snap = snapshotByUser.get(a.user_id);
        const inSnapshot = snap?.achievements.some((s) => s.achievementId === a.achievement_id) ?? false;
        if (inSnapshot) continue;
        if (a.source_match_id != null && !receiptMatchSet.has(a.source_match_id)) {
          flag(a.user_id, `achievement ${a.achievement_id} sourced from non-receipt match ${a.source_match_id}`);
        }
      }

      if (offending.size > 0) {
        throw new RollbackRefusedError(`post-snapshot live activity on roster bots — refused:\n  ${reasons.slice(0, 12).join('\n  ')}`);
      }

      // 2. Per-match verification (exact pair + burnIn tag + fixture-key + roster).
      const dbMatches = await tx<{ id: string; ranked_context: { burnIn?: unknown; fixtureKey?: unknown } | null }[]>`
        SELECT id, ranked_context FROM matches WHERE id = ANY(${receiptMatchIds}::uuid[])
      `;
      const dbMatchById = new Map(dbMatches.map((m) => [m.id, m]));
      const dbPlayers = await tx<{ match_id: string; user_id: string; seat: number }[]>`
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
        if (ctx.burnIn !== true) throw new RollbackRefusedError(`match ${matchId} not tagged burnIn=true — refusing`);
        if (ctx.fixtureKey !== fx.key) throw new RollbackRefusedError(`match ${matchId} fixtureKey mismatch — refusing`);
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

      // 3. Delete burn-in matches + their ledger/xp; achievements sourced from
      // them are cleared by the per-bot achievement restore below.
      if (verifiedMatchIds.length > 0) {
        await tx`DELETE FROM ranked_rp_changes WHERE match_id = ANY(${verifiedMatchIds}::uuid[])`;
        await tx`DELETE FROM user_xp_events WHERE source_type = 'match_result' AND source_key = ANY(${verifiedMatchIds})`;
        const deleted = await tx<{ id: string }[]>`
          DELETE FROM matches WHERE id = ANY(${verifiedMatchIds}::uuid[]) RETURNING id
        `;
        matchesDeleted = deleted.length;
      }

      // 4. Restore every captured field for exactly the receipt roster.
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
              last_ranked_match_at = ${p.lastRankedMatchAt}, updated_at = NOW()
            WHERE user_id = ${p.userId}
          `;
        } else {
          await tx`DELETE FROM ranked_profiles WHERE user_id = ${p.userId}`;
        }

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

        // user_achievements: delete ONLY the rows NOT in the snapshot set. After
        // the drift validation above, every such row is burn-in-created (a live
        // achievement would have aborted the rollback), so this deletes only
        // burn-in-created achievements, never a pre-existing one. Then restore
        // the snapshot set verbatim.
        await tx`
          DELETE FROM user_achievements
          WHERE user_id = ${p.userId}
            AND achievement_id <> ALL(${p.achievements.map((a) => a.achievementId)}::text[])
        `;
        for (const a of p.achievements) {
          await tx`
            INSERT INTO user_achievements (user_id, achievement_id, progress, unlocked_at, source_match_id, created_at, updated_at)
            VALUES (${p.userId}, ${a.achievementId}, ${a.progress}, ${a.unlockedAt}, ${a.sourceMatchId}, ${a.createdAt}, ${a.updatedAt})
            ON CONFLICT (user_id, achievement_id) DO UPDATE SET
              progress = EXCLUDED.progress, unlocked_at = EXCLUDED.unlocked_at,
              source_match_id = EXCLUDED.source_match_id, updated_at = EXCLUDED.updated_at
          `;
        }
      }

      // Clear the one-time marker so the env can be re-run after a full rollback.
      await tx`DELETE FROM bot_model_params WHERE note = ${BURN_IN_MARKER_NOTE}`;
    });
  } catch (err) {
    if (err instanceof RollbackRefusedError) throw err;
    throw err;
  }

  return { matchesDeleted, profilesRestored: snapshot.profiles.length };
}
