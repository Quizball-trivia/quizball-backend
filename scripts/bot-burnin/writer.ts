/**
 * Transactional historical-fixture writer.
 *
 * Per planned fixture it inserts a completed-shaped ranked match + both
 * match_players seats with BACKDATED started_at, then drives the REAL
 * production settlement path with the fixture's timestamp injected:
 *   completeMatch(occurredAt) → settleCompletedRankedMatch(occurredAt)
 *     → awardCompletedMatchXp(occurredAt) → evaluateForMatch(occurredAt)
 * so RP/W-L/streak/placement/XP/achievements land exactly as a live match
 * would have, only dated in the past. No coins/tickets/notifications/analytics
 * fire (persistent bots are AI for economy/analytics — enforced by the
 * settlement/XP/achievement code paths themselves, not re-implemented here).
 *
 * Idempotency & resume safety (finding 4): the match id is the deterministic
 * UUID derived from the fixture's canonical content digest. On resume an
 * existing row is accepted ONLY after a field-by-field match (participants,
 * ranked_context.burnIn tag, timestamps, winner, scores); any mismatch aborts
 * with diagnostics rather than silently completing a foreign row.
 *
 * Ceiling belt (finding 5): after settlement the writer re-reads both bots and
 * throws if either now exceeds the ceiling, aborting the run.
 */
import { sql } from '../../src/db/index.js';
import { matchesService } from '../../src/modules/matches/matches.service.js';
import { rankedService } from '../../src/modules/ranked/ranked.service.js';
import { progressionService } from '../../src/modules/progression/progression.service.js';
import { achievementsService } from '../../src/modules/achievements/index.js';
import type { PlannedFixture } from './types.js';

export class FixtureVerificationError extends Error {}
export class CeilingExceededError extends Error {}

export interface WriteFixtureResult {
  matchId: string;
  created: boolean;
}

/**
 * Verify an already-present match row matches this fixture EXACTLY before
 * treating it as a resumed write. Throws FixtureVerificationError on any drift.
 */
async function verifyExistingMatch(fixture: PlannedFixture): Promise<void> {
  const matchId = fixture.matchId;
  const [match] = await sql<
    {
      status: string;
      is_dev: boolean;
      started_at: string;
      ended_at: string | null;
      winner_user_id: string | null;
      ranked_context: unknown;
    }[]
  >`SELECT status, is_dev, started_at, ended_at, winner_user_id, ranked_context FROM matches WHERE id = ${matchId}`;
  if (!match) throw new FixtureVerificationError(`resume: match ${matchId} vanished mid-run`);

  const ctx = (match.ranked_context ?? {}) as { burnIn?: unknown };
  if (ctx.burnIn !== true) {
    throw new FixtureVerificationError(`resume: match ${matchId} is not a burn-in match (ranked_context.burnIn !== true)`);
  }
  if (new Date(match.started_at).toISOString() !== fixture.startedAt.toISOString()) {
    throw new FixtureVerificationError(`resume: match ${matchId} started_at drift`);
  }

  const players = await sql<{ user_id: string; seat: number; goals: number; penalty_goals: number; total_points: number; correct_answers: number }[]>`
    SELECT user_id, seat, goals, penalty_goals, total_points, correct_answers
    FROM match_players WHERE match_id = ${matchId} ORDER BY seat
  `;
  const seatA = players.find((p) => p.seat === 1);
  const seatB = players.find((p) => p.seat === 2);
  if (seatA?.user_id !== fixture.botAUserId || seatB?.user_id !== fixture.botBUserId) {
    throw new FixtureVerificationError(`resume: match ${matchId} participant drift`);
  }
  const scoreOk = (row: typeof seatA, s: PlannedFixture['scoreA']) =>
    row != null && row.goals === s.goals && row.penalty_goals === s.penaltyGoals
    && row.total_points === s.totalPoints && row.correct_answers === s.correctAnswers;
  if (!scoreOk(seatA, fixture.scoreA) || !scoreOk(seatB, fixture.scoreB)) {
    throw new FixtureVerificationError(`resume: match ${matchId} scoreline drift`);
  }
  // If the row is completed already, its winner must match too.
  if (match.status === 'completed' && match.winner_user_id !== fixture.winnerUserId) {
    throw new FixtureVerificationError(`resume: match ${matchId} winner drift`);
  }
}

/**
 * Insert the completed-shaped match rows for one fixture (backdated), if absent.
 * Returns created=false when the match already exists AND verifies identical.
 */
async function insertHistoricalMatch(fixture: PlannedFixture): Promise<WriteFixtureResult> {
  const matchId = fixture.matchId;

  const existing = await sql<{ id: string }[]>`SELECT id FROM matches WHERE id = ${matchId}`;
  if (existing.length > 0) {
    await verifyExistingMatch(fixture);
    return { matchId, created: false };
  }

  await sql.begin(async (tx) => {
    // Re-check inside the tx (another resume worker may race us).
    const race = await tx<{ id: string }[]>`SELECT id FROM matches WHERE id = ${matchId}`;
    if (race.length > 0) return;

    // Completed-shaped ranked match. is_dev=false so it aggregates stats like a
    // real ranked game. status starts 'active' so the real completeMatch path
    // can flip it and fan out user_mode_match_stats.
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
        ${sql.json({ isPlacement: fixture.isPlacementContext, burnIn: true, fixtureKey: fixture.key })},
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
  });

  return { matchId, created: true };
}

/**
 * Write + settle one fixture end-to-end with the fixture's backdated timestamp.
 * Safe to re-run: completion/settlement/XP/achievements are each idempotent on
 * the match id. `ceilingRp` (when provided) is asserted after settlement.
 */
export async function writeFixture(fixture: PlannedFixture, ceilingRp?: number): Promise<WriteFixtureResult> {
  const result = await insertHistoricalMatch(fixture);

  // Drive the REAL production functions with the injected historical timestamp.
  // completeMatch is a no-op if already completed; settlement + XP + achievement
  // evaluation are idempotent, so resume never double-writes.
  await matchesService.completeMatch(result.matchId, fixture.winnerUserId, fixture.endedAt);
  await rankedService.settleCompletedRankedMatch(result.matchId, fixture.endedAt);
  await progressionService.awardCompletedMatchXp(result.matchId, fixture.endedAt);
  // Achievements: same pipeline as live completion, backdated + analytics-off
  // (capability matrix — persistent bots stay out of analytics).
  await achievementsService.evaluateForMatch(
    result.matchId,
    [fixture.botAUserId, fixture.botBUserId],
    'ranked_sim',
    { occurredAt: fixture.endedAt, suppressAnalytics: true },
  );

  // Ceiling belt (finding 5): re-read both bots' settled RP and abort if either
  // exceeds the ceiling. Backstops the pairing-level enforcement under drift.
  if (ceilingRp != null) {
    const rows = await sql<{ user_id: string; rp: number }[]>`
      SELECT user_id, rp FROM ranked_profiles
      WHERE user_id IN (${fixture.botAUserId}, ${fixture.botBUserId})
    `;
    for (const r of rows) {
      if (r.rp > ceilingRp) {
        throw new CeilingExceededError(
          `bot ${r.user_id} settled to RP ${r.rp} > ceiling ${ceilingRp} on match ${result.matchId}`,
        );
      }
    }
  }

  return result;
}
