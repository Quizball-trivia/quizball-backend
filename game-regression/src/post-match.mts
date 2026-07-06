/**
 * Post-match DB-state checks — the half of the "did the match really finish
 * cleanly" question the event trace can't answer. After final_results, the engine
 * settles ranked RP, awards XP, evaluates objectives/achievements, and marks the
 * match completed. These assert the persisted side effects actually landed:
 *   - the match row is COMPLETED with a coherent winner
 *   - per-player totals are recorded
 *   - (ranked) exactly one ranked_rp_changes row per HUMAN player, with
 *     new_rp === max(0, old_rp + delta_rp), winner gains / loser loses, and the
 *     ranked_profiles.rp moved to new_rp
 *   - match-result XP events were written (one per human player)
 *
 * These map to the user's post-match checklist: results displaying, rank
 * increasing/decreasing, objectives/XP firing. Uses the engine's own sql client.
 */
import { sql } from '../../src/db/index.js';

export interface PostMatchViolation {
  check: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface PostMatchResult {
  ok: boolean;
  violations: PostMatchViolation[];
  /** Surfaced for tests/logging even when ok. */
  facts: {
    status: string | null;
    winnerUserId: string | null;
    mode: string | null;
    humanPlayerIds: string[];
    rpChangeCount: number;
    xpEventCount: number;
  };
}

export interface PostMatchOptions {
  allowAbandoned?: boolean;
}

interface MatchRow { status: string; mode: string; winner_user_id: string | null; }
interface PlayerRow { user_id: string; is_ai: boolean; total_points: number | null; correct_answers: number | null; }
interface RpRow { user_id: string; old_rp: number; delta_rp: number; new_rp: number; result: string; }
interface ProfileRow { user_id: string; rp: number; }

/**
 * Check the persisted post-match state for `matchId`. `expectRanked` controls the
 * ranked-only assertions (RP changes + profile move); pass the match's mode.
 */
export async function checkPostMatchState(
  matchId: string,
  options: PostMatchOptions = {},
): Promise<PostMatchResult> {
  const v: PostMatchViolation[] = [];

  const [match] = await sql<MatchRow[]>`
    SELECT status, mode, winner_user_id FROM matches WHERE id = ${matchId}`;
  const players = await sql<PlayerRow[]>`
    SELECT mp.user_id, u.is_ai, mp.total_points, mp.correct_answers
    FROM match_players mp JOIN users u ON u.id = mp.user_id
    WHERE mp.match_id = ${matchId}`;
  const humanPlayerIds = players.filter((p) => !p.is_ai).map((p) => p.user_id);

  const facts: PostMatchResult['facts'] = {
    status: match?.status ?? null,
    winnerUserId: match?.winner_user_id ?? null,
    mode: match?.mode ?? null,
    humanPlayerIds,
    rpChangeCount: 0,
    xpEventCount: 0,
  };

  if (!match) {
    v.push({ check: 'matchExists', message: `No match row for ${matchId}.` });
    return { ok: false, violations: v, facts };
  }

  const acceptedTerminalStatus = match.status === 'completed' || (options.allowAbandoned === true && match.status === 'abandoned');

  // 1. Match reached an accepted terminal status with a coherent winner (winner is a participant, or null for draw).
  if (!acceptedTerminalStatus) {
    const expected = options.allowAbandoned === true ? '"completed" or "abandoned"' : '"completed"';
    v.push({ check: 'matchCompleted', message: `Match status is "${match.status}", expected ${expected}.`, detail: { status: match.status } });
  }
  if (match.winner_user_id !== null && !players.some((p) => p.user_id === match.winner_user_id)) {
    v.push({ check: 'winnerIsParticipant', message: `winner_user_id ${match.winner_user_id} is not a match participant.`, detail: { winner: match.winner_user_id } });
  }
  if (match.status !== 'completed') {
    return { ok: v.length === 0, violations: v, facts };
  }

  // 2. Per-player totals recorded (numbers, not null).
  for (const p of players) {
    if (p.total_points === null || p.correct_answers === null) {
      v.push({ check: 'playerTotalsRecorded', message: `match_players ${p.user_id} has null totals (points=${p.total_points}, correct=${p.correct_answers}).`, detail: { userId: p.user_id } });
    }
  }

  // 3. Ranked settlement (ranked mode only): RP changes + profile move.
  if (match.mode === 'ranked') {
    const rpRows = await sql<RpRow[]>`
      SELECT user_id, old_rp, delta_rp, new_rp, result FROM ranked_rp_changes WHERE match_id = ${matchId}`;
    facts.rpChangeCount = rpRows.length;
    const rpByUser = new Map(rpRows.map((r) => [r.user_id, r]));

    // Exactly one RP change per HUMAN player (AI opponents don't get rated rows).
    for (const userId of humanPlayerIds) {
      const r = rpByUser.get(userId);
      if (!r) {
        v.push({ check: 'rankedRpChangeExists', message: `No ranked_rp_changes row for human player ${userId}.`, detail: { userId } });
        continue;
      }
      // new_rp must equal max(0, old_rp + delta_rp) — the floored arithmetic.
      const expected = Math.max(0, r.old_rp + r.delta_rp);
      if (r.new_rp !== expected) {
        v.push({ check: 'rankedRpArithmetic', message: `RP arithmetic off for ${userId}: new_rp ${r.new_rp} != max(0, ${r.old_rp}+${r.delta_rp})=${expected}.`, detail: { userId, ...r, expected } });
      }
      // Direction: a win must not lose RP and a loss must not gain RP (placement
      // seeding can be flat, so only assert the sign doesn't contradict the result).
      if (r.result === 'win' && r.delta_rp < 0) {
        v.push({ check: 'rankedRpDirection', message: `Win for ${userId} but delta_rp ${r.delta_rp} < 0.`, detail: { userId, ...r } });
      }
      if (r.result === 'loss' && r.delta_rp > 0) {
        v.push({ check: 'rankedRpDirection', message: `Loss for ${userId} but delta_rp ${r.delta_rp} > 0.`, detail: { userId, ...r } });
      }
      // result must agree with who won.
      const isWinner = match.winner_user_id === userId;
      if (match.winner_user_id !== null) {
        if (isWinner && r.result !== 'win') v.push({ check: 'rankedResultMatchesWinner', message: `${userId} won the match but ranked result is "${r.result}".`, detail: { userId, result: r.result } });
        if (!isWinner && r.result !== 'loss') v.push({ check: 'rankedResultMatchesWinner', message: `${userId} did not win but ranked result is "${r.result}".`, detail: { userId, result: r.result } });
      }

      // The profile rp must have moved to new_rp.
      const [profile] = await sql<ProfileRow[]>`SELECT user_id, rp FROM ranked_profiles WHERE user_id = ${userId}`;
      if (!profile) {
        v.push({ check: 'rankedProfileExists', message: `No ranked_profiles row for ${userId} after a ranked match.`, detail: { userId } });
      } else if (profile.rp !== r.new_rp) {
        v.push({ check: 'rankedProfileRpMoved', message: `ranked_profiles.rp for ${userId} is ${profile.rp}, expected new_rp ${r.new_rp}.`, detail: { userId, profileRp: profile.rp, newRp: r.new_rp } });
      }
    }
  }

  // 4. Match-result XP events written (one per human player).
  const [{ count: xpCount } = { count: 0 }] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM user_xp_events
    WHERE source_type = 'match_result' AND source_key = ${matchId}`;
  facts.xpEventCount = xpCount;
  if (humanPlayerIds.length > 0 && xpCount < humanPlayerIds.length) {
    v.push({ check: 'matchXpAwarded', message: `Expected >= ${humanPlayerIds.length} match_result XP events, found ${xpCount}.`, detail: { expected: humanPlayerIds.length, found: xpCount } });
  }

  return { ok: v.length === 0, violations: v, facts };
}

/** Human-readable one-liner per post-match violation, for reports. */
export function formatPostMatchViolation(v: PostMatchViolation): string {
  const detail = v.detail ? ` ${JSON.stringify(v.detail)}` : '';
  return `[${v.check}] ${v.message}${detail}`;
}
