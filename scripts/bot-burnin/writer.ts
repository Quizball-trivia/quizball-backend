/**
 * Transactional historical-fixture writer.
 *
 * Per planned fixture it inserts a completed-shaped ranked match + both
 * match_players seats with BACKDATED started_at, then drives the REAL
 * production settlement path with the fixture's timestamp injected:
 *   completeMatch(occurredAt) → settleCompletedRankedMatch(occurredAt)
 *     → awardCompletedMatchXp(occurredAt)
 * so RP/W-L/streak/placement/XP land exactly as a live match would have, only
 * dated in the past. No coins/tickets/notifications/analytics fire (persistent
 * bots are AI for economy/analytics — enforced by the settlement/XP code paths
 * themselves, not re-implemented here).
 *
 * Idempotency: the match is inserted with a deterministic id derived from the
 * fixture key, and both the match insert and the settlement path are
 * ON CONFLICT DO NOTHING / per-participant idempotent, so a crashed run
 * resumes without duplicating fixtures. Every created match id is appended to
 * the receipt for schema-free rollback.
 */
import { createHash } from 'node:crypto';
import { sql } from '../../src/db/index.js';
import { matchesService } from '../../src/modules/matches/matches.service.js';
import { rankedService } from '../../src/modules/ranked/ranked.service.js';
import { progressionService } from '../../src/modules/progression/progression.service.js';
import type { PlannedFixture } from './types.js';

/** Deterministic match UUID from a fixture key (stable across resumed runs). */
export function fixtureMatchId(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  // Format as a v4-shaped UUID (version/variant nibbles set) for schema sanity.
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-` +
    `${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
  );
}

export interface WriteFixtureResult {
  matchId: string;
  created: boolean;
}

/**
 * Insert the completed-match rows for one fixture (backdated), if absent.
 * Returns created=false when the match already exists (resume path).
 */
async function insertHistoricalMatch(fixture: PlannedFixture): Promise<WriteFixtureResult> {
  const matchId = fixtureMatchId(fixture.key);

  return (await sql.begin(async (tx) => {
    const existing = await tx<{ id: string }[]>`SELECT id FROM matches WHERE id = ${matchId}`;
    if (existing.length > 0) return { matchId, created: false };

    // Completed-shaped ranked match. is_dev=false so it aggregates stats like a
    // real ranked game (§ writer requirement). status starts 'active' so the
    // real completeMatch path can flip it and fan out user_mode_match_stats.
    await tx`
      INSERT INTO matches (
        id, mode, status, category_a_id, category_b_id,
        current_q_index, total_questions, state_payload, ranked_context,
        is_dev, started_at
      )
      VALUES (
        ${matchId}, 'ranked', 'active', ${fixture.categoryAId}, ${fixture.categoryBId},
        12, 12,
        ${sql.json({ winnerDecisionMethod: fixture.decision })},
        ${sql.json({ isPlacement: fixture.isPlacementContext, burnIn: true })},
        false, ${fixture.startedAt}
      )
    `;

    await tx`
      INSERT INTO match_players (
        match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals
      )
      VALUES
        (${matchId}, ${fixture.botAUserId}, 1, ${fixture.scoreA.totalPoints},
         ${fixture.scoreA.correctAnswers}, ${fixture.scoreA.goals}, ${fixture.scoreA.penaltyGoals}),
        (${matchId}, ${fixture.botBUserId}, 2, ${fixture.scoreB.totalPoints},
         ${fixture.scoreB.correctAnswers}, ${fixture.scoreB.goals}, ${fixture.scoreB.penaltyGoals})
    `;

    return { matchId, created: true };
  })) as WriteFixtureResult;
}

/**
 * Write + settle one fixture end-to-end with the fixture's backdated timestamp.
 * Safe to re-run: completion/settlement/XP are each idempotent on the match id.
 */
export async function writeFixture(fixture: PlannedFixture): Promise<WriteFixtureResult> {
  const result = await insertHistoricalMatch(fixture);

  // Drive the REAL production functions with the injected historical timestamp.
  // completeMatch is a no-op if already completed; settlement + XP are
  // per-participant/per-source idempotent, so resume never double-writes.
  await matchesService.completeMatch(result.matchId, fixture.winnerUserId, fixture.endedAt);
  await rankedService.settleCompletedRankedMatch(result.matchId, fixture.endedAt);
  await progressionService.awardCompletedMatchXp(result.matchId, fixture.endedAt);

  return result;
}
