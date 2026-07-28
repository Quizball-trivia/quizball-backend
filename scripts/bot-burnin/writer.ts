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
import { computeSeasonRpDelta, SEASON_INITIAL_RP } from '../../src/modules/ranked/season-rp-formula.js';
import { assertRunOwned } from './data.js';
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
      mode: string;
      status: string;
      is_dev: boolean;
      started_at: string;
      ended_at: string | null;
      winner_user_id: string | null;
      category_a_id: string | null;
      category_b_id: string | null;
      state_payload: { winnerDecisionMethod?: unknown } | null;
      ranked_context: { burnIn?: unknown; fixtureKey?: unknown; isPlacement?: unknown } | null;
    }[]
  >`SELECT mode, status, is_dev, started_at, ended_at, winner_user_id, category_a_id, category_b_id, state_payload, ranked_context FROM matches WHERE id = ${matchId}`;
  if (!match) throw new FixtureVerificationError(`resume: match ${matchId} vanished mid-run`);

  const fail = (why: string): never => {
    throw new FixtureVerificationError(`resume: match ${matchId} ${why} — not the planned fixture, aborting`);
  };

  const ctx = match.ranked_context ?? {};
  // Identity: the burn-in tag + the exact canonical fixture key (H-bound).
  if (ctx.burnIn !== true) fail('is not tagged burnIn=true');
  if (ctx.fixtureKey !== fixture.key) fail(`fixtureKey drift (db=${String(ctx.fixtureKey)})`);
  // Shape invariants the writer always sets.
  if (match.mode !== 'ranked') fail(`mode drift (db=${match.mode})`);
  if (match.is_dev !== false) fail('is_dev drift (expected false)');
  if (ctx.isPlacement !== fixture.isPlacementContext) fail('isPlacement context drift');
  const decision = match.state_payload?.winnerDecisionMethod;
  if (decision !== fixture.decision) fail(`decision drift (db=${String(decision)})`);
  if (match.category_a_id !== fixture.categoryAId || match.category_b_id !== fixture.categoryBId) fail('category drift');
  // Timestamps.
  if (new Date(match.started_at).toISOString() !== fixture.startedAt.toISOString()) fail('started_at drift');
  // Status must be a burn-in-shaped one (active mid-run, or completed on resume).
  if (match.status !== 'active' && match.status !== 'completed') fail(`status drift (db=${match.status})`);
  if (match.status === 'completed') {
    if (match.winner_user_id !== fixture.winnerUserId) fail('winner drift');
    if (match.ended_at == null || new Date(match.ended_at).toISOString() !== fixture.endedAt.toISOString()) fail('ended_at drift');
  }

  const players = await sql<{ user_id: string; seat: number; goals: number; penalty_goals: number; total_points: number; correct_answers: number }[]>`
    SELECT user_id, seat, goals, penalty_goals, total_points, correct_answers
    FROM match_players WHERE match_id = ${matchId} ORDER BY seat
  `;
  const seatA = players.find((p) => p.seat === 1);
  const seatB = players.find((p) => p.seat === 2);
  if (seatA?.user_id !== fixture.botAUserId || seatB?.user_id !== fixture.botBUserId) fail('participant drift');
  const scoreOk = (row: typeof seatA, s: PlannedFixture['scoreA']) =>
    row != null && row.goals === s.goals && row.penalty_goals === s.penaltyGoals
    && row.total_points === s.totalPoints && row.correct_answers === s.correctAnswers;
  if (!scoreOk(seatA, fixture.scoreA) || !scoreOk(seatB, fixture.scoreB)) fail('scoreline drift');
}

/**
 * Insert the completed-shaped match rows for one fixture (backdated), if absent.
 * Returns created=false when the match already exists AND verifies identical.
 * The insert tx re-checks lock ownership FAIL-CLOSED so a fixture can never land
 * after the run lost its lock (P1-3).
 */
async function insertHistoricalMatch(fixture: PlannedFixture, owner: RunOwner): Promise<WriteFixtureResult> {
  const matchId = fixture.matchId;

  const existing = await sql<{ id: string }[]>`SELECT id FROM matches WHERE id = ${matchId}`;
  if (existing.length > 0) {
    await verifyExistingMatch(fixture);
    return { matchId, created: false };
  }

  await sql.begin(async (tx) => {
    // Fail-closed: only proceed if we STILL own the run lock (marker row shows
    // 'running' + our token). A takeover/rollback aborts this insert.
    await assertRunOwned(tx, owner.manifestHash, owner.ownerToken);
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
 * Assert PRE-COMMIT (before any settlement writes) that this fixture cannot push
 * either bot over the ceiling (finding 6). Computes the exact post-settlement RP
 * from each bot's CURRENT DB profile using the SAME production formula the
 * settlement will apply, and throws before writing anything if it would exceed
 * the ceiling. This runs against live DB RP so it also catches drift, not just
 * the in-memory projection.
 */
async function assertCeilingPreCommit(fixture: PlannedFixture, ceilingRp: number): Promise<void> {
  const profiles = await sql<{ user_id: string; rp: number }[]>`
    SELECT user_id, rp FROM ranked_profiles
    WHERE user_id IN (${fixture.botAUserId}, ${fixture.botBUserId})
  `;
  const rpByUser = new Map(profiles.map((p) => [p.user_id, p.rp]));
  const rpA = rpByUser.get(fixture.botAUserId) ?? SEASON_INITIAL_RP;
  const rpB = rpByUser.get(fixture.botBUserId) ?? SEASON_INITIAL_RP;
  const aWon = fixture.winnerUserId === fixture.botAUserId;
  const goalMarginA = fixture.scoreA.goals - fixture.scoreB.goals;

  const deltaA = computeSeasonRpDelta(aWon, fixture.decision, goalMarginA, rpB > rpA);
  const deltaB = computeSeasonRpDelta(!aWon, fixture.decision, -goalMarginA, rpA > rpB);
  const newRpA = Math.max(0, rpA + deltaA);
  const newRpB = Math.max(0, rpB + deltaB);

  if (newRpA > ceilingRp) {
    throw new CeilingExceededError(
      `bot ${fixture.botAUserId} would settle to RP ${newRpA} > ceiling ${ceilingRp} on match ${fixture.matchId} — aborting BEFORE any write`,
    );
  }
  if (newRpB > ceilingRp) {
    throw new CeilingExceededError(
      `bot ${fixture.botBUserId} would settle to RP ${newRpB} > ceiling ${ceilingRp} on match ${fixture.matchId} — aborting BEFORE any write`,
    );
  }
}

/** Identifies the current run for the fail-closed lock re-check (P1-3). */
export interface RunOwner {
  manifestHash: string;
  ownerToken: string;
}

/**
 * Write + settle one fixture end-to-end with the fixture's backdated timestamp.
 * Safe to re-run: completion/settlement/XP/achievements are each idempotent on
 * the match id. When `ceilingRp` is provided the ceiling is asserted PRE-COMMIT,
 * so a violation is refused before any settlement write lands. `owner` gates
 * every write on still holding the run lock (fail-closed).
 */
export async function writeFixture(fixture: PlannedFixture, owner: RunOwner, ceilingRp?: number): Promise<WriteFixtureResult> {
  // Ceiling assertion FIRST (finding 6 + P2-1): compute the projected post-
  // settlement RP from live DB profiles and refuse before writing anything if it
  // exceeds the ceiling. This runs whenever the fixture is NOT yet settled — so
  // a crash-written 'active' fixture is RE-ASSERTED on resume before it settles.
  const settledAlready = await sql<{ status: string }[]>`
    SELECT status FROM matches WHERE id = ${fixture.matchId}
  `;
  const isCompleted = settledAlready[0]?.status === 'completed';
  if (ceilingRp != null && !isCompleted) {
    await assertCeilingPreCommit(fixture, ceilingRp);
  }

  const result = await insertHistoricalMatch(fixture, owner);

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

  return result;
}
