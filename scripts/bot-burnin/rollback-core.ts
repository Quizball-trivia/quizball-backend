/**
 * Trivial rollback for the plan-all-then-execute-in-one-transaction burn-in.
 *
 * A completed run committed EXACTLY the plan (a pure function of H). Rollback
 * therefore needs no snapshot and no receipt: it recomputes the plan's match
 * ids from the same immutable inputs, deletes exactly those matches (+ their
 * ledger/xp/achievements), and resets every roster bot to the known pristine
 * baseline (SEASON_INITIAL_RP / unplaced / 0 — constant by the pristine gate),
 * all inside ONE transaction under the xact advisory lock.
 *
 * The ONLY drift case is a real match a bot played AFTER burn-in (e.g. once the
 * flag flipped). Guard: refuse if any roster bot has a match_players row whose
 * match_id is NOT in the plan.
 */
import { sql } from '../../src/db/index.js';
import { SEASON_INITIAL_RP, tierFromRp } from '../../src/modules/ranked/season-rp-formula.js';
import { lockBurnIn } from './data.js';

const BURN_IN_MARKER_NOTE = 'persistent-bot-burnin:complete';

export class RollbackRefusedError extends Error {}

export interface RollbackResult {
  matchesDeleted: number;
  botsReset: number;
}

/**
 * @param planMatchIds  the deterministic match ids of the recomputed plan
 * @param rosterUserIds the roster bot ids (must equal the plan participants)
 */
export async function rollbackBurnIn(planMatchIds: string[], rosterUserIds: string[]): Promise<RollbackResult> {
  const planMatchSet = new Set(planMatchIds);

  return (await sql.begin(async (tx) => {
    await lockBurnIn(tx); // serialize vs any concurrent execute

    // Lock the roster rows so nothing races the reset.
    await tx`SELECT id FROM users WHERE id = ANY(${rosterUserIds}::uuid[]) FOR UPDATE`;

    // Drift guard: any match a roster bot participated in that is NOT in the plan
    // is real post-burn-in activity — refuse rather than delete/reset over it.
    const foreign = await tx<{ match_id: string; user_id: string }[]>`
      SELECT DISTINCT mp.match_id, mp.user_id
      FROM match_players mp
      WHERE mp.user_id = ANY(${rosterUserIds}::uuid[])
        AND mp.match_id <> ALL(${planMatchIds}::uuid[])
    `;
    if (foreign.length > 0) {
      const sample = foreign.slice(0, 8).map((f) => `${f.user_id}@${f.match_id}`).join(', ');
      throw new RollbackRefusedError(
        `refusing rollback: ${foreign.length} non-plan match(es) on roster bots (post-burn-in activity): ${sample}`,
      );
    }

    // Delete the plan's matches + their derived rows. Only matches that both are
    // in the plan AND are tagged burnIn (belt-and-braces).
    const present = await tx<{ id: string }[]>`
      SELECT id FROM matches WHERE id = ANY(${planMatchIds}::uuid[]) AND ranked_context->>'burnIn' = 'true'
    `;
    const deletableIds = present.map((m) => m.id).filter((id) => planMatchSet.has(id));

    let matchesDeleted = 0;
    if (deletableIds.length > 0) {
      await tx`DELETE FROM ranked_rp_changes WHERE match_id = ANY(${deletableIds}::uuid[])`;
      await tx`DELETE FROM user_xp_events WHERE source_type = 'match_result' AND source_key = ANY(${deletableIds})`;
      // match_players / match_answers cascade on match delete.
      const deleted = await tx<{ id: string }[]>`
        DELETE FROM matches WHERE id = ANY(${deletableIds}::uuid[]) RETURNING id
      `;
      matchesDeleted = deleted.length;
    }

    // Reset every roster bot to the pristine baseline (the known pre-state).
    // users.total_xp and any achievements the burn-in granted are also cleared:
    // a pristine bot has total_xp=0 and no achievements/xp events.
    await tx`
      UPDATE ranked_profiles SET
        rp = ${SEASON_INITIAL_RP}, tier = ${tierFromRp(SEASON_INITIAL_RP)},
        placement_status = 'unplaced', placement_played = 0, placement_wins = 0,
        placement_seed_rp = NULL, placement_perf_sum = 0,
        placement_points_for_sum = 0, placement_points_against_sum = 0,
        current_win_streak = 0, last_ranked_match_at = NULL, updated_at = NOW()
      WHERE user_id = ANY(${rosterUserIds}::uuid[])
    `;
    await tx`UPDATE users SET total_xp = 0 WHERE id = ANY(${rosterUserIds}::uuid[])`;
    await tx`DELETE FROM user_mode_match_stats WHERE user_id = ANY(${rosterUserIds}::uuid[]) AND mode = 'ranked'`;
    await tx`DELETE FROM user_achievements WHERE user_id = ANY(${rosterUserIds}::uuid[])`;
    // Any stray non-match xp events on these fresh bots are burn-in artifacts too.
    await tx`DELETE FROM user_xp_events WHERE user_id = ANY(${rosterUserIds}::uuid[])`;

    // Clear the one-time marker so the env can be re-burned after a full rollback.
    await tx`DELETE FROM bot_model_params WHERE note = ${BURN_IN_MARKER_NOTE}`;

    return { matchesDeleted, botsReset: rosterUserIds.length };
  })) as RollbackResult;
}
