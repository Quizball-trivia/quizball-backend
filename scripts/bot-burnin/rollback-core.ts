/**
 * Rollback for the plan-then-execute burn-in.
 *
 * A completed run committed EXACTLY the plan (a pure function of H). Rollback
 * recomputes the plan's match ids and deletes ONLY the burn-in-created rows —
 * matches in the plan, their ledger/xp/achievements — and resets each roster
 * bot to the known pristine baseline (SEASON_INITIAL_RP / unplaced / 0), all in
 * ONE transaction under the xact advisory lock.
 *
 * FAIL CLOSED (P1): rollback must NEVER destroy non-burn-in progression. It
 * refuses (deleting nothing) for the WHOLE run if any roster bot has ANY of:
 *   - a match_players row for a match NOT in the plan (real post-burn-in match)
 *   - a user_xp_events row NOT sourced from a plan match (daily/objective XP)
 *   - a user_achievements row NOT sourced from a plan match (a real unlock)
 * i.e. anything rollback can't cleanly reverse to pristine without touching
 * non-plan data. total_xp is DECREMENTED by exactly the burn-in XP (not zeroed).
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

export async function rollbackBurnIn(planMatchIds: string[], rosterUserIds: string[]): Promise<RollbackResult> {
  return (await sql.begin(async (tx) => {
    await lockBurnIn(tx); // serialize vs any concurrent execute

    // Lock the roster rows so nothing races the reset.
    await tx`SELECT id FROM users WHERE id = ANY(${rosterUserIds}::uuid[]) FOR UPDATE`;

    // ── Fail-closed refusal checks (any non-burn-in data → refuse the whole run) ─
    // 1. Any match a roster bot played that is NOT in the plan.
    const foreignMatches = await tx<{ match_id: string; user_id: string }[]>`
      SELECT DISTINCT mp.match_id, mp.user_id
      FROM match_players mp
      WHERE mp.user_id = ANY(${rosterUserIds}::uuid[])
        AND mp.match_id <> ALL(${planMatchIds}::uuid[])
    `;
    if (foreignMatches.length > 0) {
      const s = foreignMatches.slice(0, 8).map((f) => `${f.user_id}@${f.match_id}`).join(', ');
      throw new RollbackRefusedError(`refusing: ${foreignMatches.length} non-plan match(es) on roster bots (post-burn-in activity): ${s}`);
    }
    // 2. Any XP event NOT sourced from a plan match (e.g. daily-challenge XP).
    const foreignXp = await tx<{ user_id: string; source_type: string; source_key: string }[]>`
      SELECT user_id, source_type, source_key FROM user_xp_events
      WHERE user_id = ANY(${rosterUserIds}::uuid[])
        AND NOT (source_type = 'match_result' AND source_key = ANY(${planMatchIds}))
    `;
    if (foreignXp.length > 0) {
      const s = foreignXp.slice(0, 8).map((x) => `${x.user_id}:${x.source_type}`).join(', ');
      throw new RollbackRefusedError(`refusing: ${foreignXp.length} non-burn-in XP event(s) on roster bots (would be destroyed): ${s}`);
    }
    // 3. An UNLOCKED achievement must be attributable to the match that earned
    // it. A burn-in unlock's source_match_id is IN the plan; anything else — an
    // unlocked achievement whose source is NULL or points OUTSIDE the plan — is
    // NOT provably ours, so REFUSE rather than delete it (fail closed). (A row
    // that is NOT unlocked — unlocked_at IS NULL — is a mere progress tracker
    // with an inherently-null source; given the foreign-match guard proved zero
    // non-plan matches and a pristine bot has no achievement rows, such progress
    // rows are burn-in-created and safe to remove below.)
    const foreignAch = await tx<{ user_id: string; achievement_id: string; source_match_id: string | null }[]>`
      SELECT user_id, achievement_id, source_match_id FROM user_achievements
      WHERE user_id = ANY(${rosterUserIds}::uuid[])
        AND unlocked_at IS NOT NULL
        AND (source_match_id IS NULL OR source_match_id <> ALL(${planMatchIds}::uuid[]))
    `;
    if (foreignAch.length > 0) {
      const s = foreignAch.slice(0, 8).map((a) => `${a.user_id}:${a.achievement_id}(src=${a.source_match_id ?? 'null'})`).join(', ');
      throw new RollbackRefusedError(`refusing: ${foreignAch.length} unlocked achievement(s) on roster bots not provably burn-in (null or non-plan source) — would be destroyed: ${s}`);
    }

    // ── All roster progression is burn-in-created → safe to reverse to pristine ─
    // Sum the burn-in XP per user BEFORE deleting (to decrement total_xp exactly).
    const xpByUser = await tx<{ user_id: string; total: number }[]>`
      SELECT user_id, COALESCE(SUM(xp_delta), 0)::int AS total FROM user_xp_events
      WHERE user_id = ANY(${rosterUserIds}::uuid[])
        AND source_type = 'match_result' AND source_key = ANY(${planMatchIds})
      GROUP BY user_id
    `;

    // Delete the plan's matches + their derived rows (only rows tagged burnIn).
    const present = await tx<{ id: string }[]>`
      SELECT id FROM matches WHERE id = ANY(${planMatchIds}::uuid[]) AND ranked_context->>'burnIn' = 'true'
    `;
    const deletableIds = present.map((m) => m.id);

    // Delete burn-in achievement rows FIRST, while source_match_id still points
    // at the plan matches: the FK is ON DELETE SET NULL, so deleting the matches
    // first would null source_match_id and orphan these unlocked rows past the
    // predicate. UNLOCKED rows sourced from a plan match, plus not-yet-unlocked
    // progress rows (null source, burn-in-created given the guards). The refusal
    // above guarantees no unlocked row is foreign/null-src, so this can never
    // touch a real, non-burn-in achievement. Match against deletableIds (the
    // present burn-in-tagged plan matches) for exactness.
    await tx`
      DELETE FROM user_achievements
      WHERE user_id = ANY(${rosterUserIds}::uuid[])
        AND (source_match_id = ANY(${deletableIds}::uuid[]) OR unlocked_at IS NULL)
    `;

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

    // Decrement total_xp by exactly the burn-in contribution (never below 0).
    for (const row of xpByUser) {
      await tx`UPDATE users SET total_xp = GREATEST(0, total_xp - ${row.total}) WHERE id = ${row.user_id}`;
    }

    // Reset ranked_profiles + ranked stats to pristine (safe: no non-plan ranked
    // matches, guaranteed by the foreign-match refusal above).
    await tx`
      UPDATE ranked_profiles SET
        rp = ${SEASON_INITIAL_RP}, tier = ${tierFromRp(SEASON_INITIAL_RP)},
        placement_status = 'unplaced', placement_played = 0, placement_wins = 0,
        placement_seed_rp = NULL, placement_perf_sum = 0,
        placement_points_for_sum = 0, placement_points_against_sum = 0,
        current_win_streak = 0, last_ranked_match_at = NULL, updated_at = NOW()
      WHERE user_id = ANY(${rosterUserIds}::uuid[])
    `;
    await tx`DELETE FROM user_mode_match_stats WHERE user_id = ANY(${rosterUserIds}::uuid[]) AND mode = 'ranked'`;

    // Clear the one-time marker so the env can be re-burned after a full rollback.
    await tx`DELETE FROM bot_model_params WHERE note = ${BURN_IN_MARKER_NOTE}`;

    return { matchesDeleted, botsReset: rosterUserIds.length };
  })) as RollbackResult;
}
