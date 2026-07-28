/**
 * Direct transactional writer for one historical persistent-bot fixture.
 *
 * The caller owns the transaction. Every match, settlement, stats, and XP row is
 * written through that injected transaction as plain SQL, with no side-effect
 * service calls: these fixtures are backdated synthetic history, not gameplay,
 * so nothing here should fire achievements, notifications, quests or analytics
 * (see the note at the end of writeFixtureInTx).
 */
import type { TransactionSql } from '../../src/db/index.js';
import { getMatchXpReward } from '../../src/modules/progression/progression.logic.js';
import {
  computeParticipantSettlement,
  tierFromRp,
  type ParticipantSettlement,
} from '../../src/modules/ranked/season-rp-formula.js';
import type { PlacementStatus } from '../../src/modules/ranked/ranked.types.js';
import type { PlannedFixture } from './types.js';
import { placementWinsForBand, type SeededBot } from './s2-distribution.js';

interface SettledParticipant {
  userId: string;
  opponentUserId: string;
  profile: LockedRankedProfile;
  opponentProfile: LockedRankedProfile;
  goals: number;
  opponentGoals: number;
  settlement: ParticipantSettlement;
}

interface LockedRankedProfile {
  user_id: string;
  rp: number;
  placement_status: PlacementStatus;
  placement_required: number;
  placement_played: number;
  placement_wins: number;
  placement_seed_rp: number | null;
  placement_perf_sum: number;
  placement_points_for_sum: number;
  placement_points_against_sum: number;
  current_win_streak: number;
}

export async function writeSeededProfilesInTx(
  tx: TransactionSql,
  seededBots: readonly SeededBot[],
): Promise<void> {
  if (seededBots.length === 0) return;
  const userIds = seededBots.map((bot) => bot.userId);
  const seededRps = seededBots.map((bot) => bot.seededRp);
  const tiers = seededBots.map((bot) => tierFromRp(bot.seededRp));
  const placementWins = seededBots.map((bot) => placementWinsForBand(bot.band));
  const updated = await tx.unsafe<{ user_id: string }[]>(
    `
    UPDATE ranked_profiles AS profile
    SET
      placement_status = 'placed',
      tier = seed.tier,
      rp = seed.rp,
      placement_played = 3,
      placement_wins = seed.placement_wins,
      placement_seed_rp = seed.rp,
      placement_perf_sum = 0,
      placement_points_for_sum = 0,
      placement_points_against_sum = 0,
      current_win_streak = 0,
      last_ranked_match_at = NULL,
      updated_at = NOW()
    FROM UNNEST($1::uuid[], $2::integer[], $3::text[], $4::integer[])
      AS seed(user_id, rp, tier, placement_wins)
    WHERE profile.user_id = seed.user_id
    RETURNING profile.user_id
    `,
    [userIds, seededRps, tiers, placementWins],
  );
  if (updated.length !== seededBots.length) {
    throw new Error(`Stage A seeded ${updated.length}/${seededBots.length} ranked profiles`);
  }
}

/**
 * Settle both seats of one fixture from a PRE-fixture snapshot of both profiles.
 *
 * Shared by the per-fixture writer and the batched chunk writer so the two can
 * never drift: identical inputs, identical `computeParticipantSettlement` calls,
 * identical RP-equality belt. Both seats settle from the SAME snapshot (neither
 * sees the other's update), which is what makes a chunk foldable in memory.
 */
function settleFixture(
  fixture: PlannedFixture,
  profileA: LockedRankedProfile,
  profileB: LockedRankedProfile,
): SettledParticipant[] {
  const participants = [
    {
      userId: fixture.botAUserId,
      opponentUserId: fixture.botBUserId,
      profile: profileA,
      opponentProfile: profileB,
      goals: fixture.scoreA.goals,
      opponentGoals: fixture.scoreB.goals,
    },
    {
      userId: fixture.botBUserId,
      opponentUserId: fixture.botAUserId,
      profile: profileB,
      opponentProfile: profileA,
      goals: fixture.scoreB.goals,
      opponentGoals: fixture.scoreA.goals,
    },
  ].map((participant) => ({
    ...participant,
    settlement: computeParticipantSettlement({
      oldRp: participant.profile.rp,
      placementStatus: participant.profile.placement_status,
      placementPlayed: participant.profile.placement_played,
      placementWins: participant.profile.placement_wins,
      placementSeedRp: participant.profile.placement_seed_rp,
      placementPerfSum: participant.profile.placement_perf_sum,
      placementPointsForSum: participant.profile.placement_points_for_sum,
      placementPointsAgainstSum: participant.profile.placement_points_against_sum,
      currentWinStreak: participant.profile.current_win_streak,
      placementRequired: participant.profile.placement_required,
      isWin: fixture.winnerUserId === participant.userId,
      decision: fixture.decision,
      goalMargin: participant.goals - participant.opponentGoals,
      opponentRp: participant.opponentProfile.rp,
      opponentIsStronger: participant.opponentProfile.rp > participant.profile.rp,
      isHumanForCoins: false,
    }),
  }));

  // Belt: the settled RP computed from the LIVE row must exactly equal the plan's
  // PROJECTED RP for this seat. Equality holds iff fixtures are applied in the
  // same order the plan projected them (chronological). This fails loud inside
  // the tx — rolling everything back — on any plan/write divergence (ordering,
  // a pristine-gate hole, or formula drift), and is strictly stronger than a
  // <= ceiling check (the plan already guarantees projectedRp <= ceiling).
  // projectedRp <= 0 means "not projected" (a hand-built fixture in a unit test);
  // the real scheduler always sets a positive projected RP. Skip the check then.
  const expectedA = fixture.projectedRpA;
  const expectedB = fixture.projectedRpB;
  if (fixture.projectionChecked || (expectedA > 0 && expectedB > 0)) {
    for (const participant of participants) {
      const expected = participant.userId === fixture.botAUserId ? expectedA : expectedB;
      if (participant.settlement.newRp !== expected) {
        throw new Error(
          `burn-in plan/write divergence on match ${fixture.matchId} bot ${participant.userId}: ` +
            `settled RP ${participant.settlement.newRp} != projected ${expected} — aborting (rolls back)`,
        );
      }
    }
  }

  return participants;
}

/** The post-settlement profile row state, as the next fixture must observe it. */
function nextProfileState(
  previous: LockedRankedProfile,
  settlement: ParticipantSettlement,
): LockedRankedProfile {
  return {
    user_id: previous.user_id,
    rp: settlement.newRp,
    placement_status: settlement.placementStatus,
    placement_required: previous.placement_required,
    placement_played: settlement.placementPlayed,
    placement_wins: settlement.placementWins,
    placement_seed_rp: settlement.placementSeedRp,
    placement_perf_sum: settlement.placementPerfSum,
    placement_points_for_sum: settlement.placementPointsForSum,
    placement_points_against_sum: settlement.placementPointsAgainstSum,
    current_win_streak: settlement.currentWinStreak,
  };
}

/**
 * Per-fixture writer. The EXECUTE path now uses writeFixtureChunkInTx instead
 * (#343), but this stays as the reference implementation: it carries the
 * settlement-parity test against the production settleCompletedRankedMatch, and
 * the equivalence gate replays a plan through BOTH writers to prove the batched
 * one lands identical state.
 */
export async function writeFixtureInTx(
  tx: TransactionSql,
  fixture: PlannedFixture,
  occurredAt?: Date,
): Promise<void> {
  const matchAt = occurredAt ?? fixture.endedAt;

  await tx.unsafe(
    `
    INSERT INTO matches (
      id,
      mode,
      status,
      winner_user_id,
      is_dev,
      started_at,
      ended_at,
      category_a_id,
      category_b_id,
      total_questions,
      current_q_index,
      state_payload,
      ranked_context
    )
    VALUES (
      $1, 'ranked', 'completed', $2, false, $3, $4, $5, $6, 12, 12,
      $7::jsonb, $8::jsonb
    )
    `,
    [
      fixture.matchId,
      fixture.winnerUserId,
      fixture.startedAt,
      fixture.endedAt,
      fixture.categoryAId,
      fixture.categoryBId,
      // postgres.js binds a JS object to a jsonb OBJECT; a JSON.stringify'd
      // string would be stored as a jsonb STRING (double-encoded) and read back
      // as a string, not an object.
      { winnerDecisionMethod: fixture.decision },
      { isPlacement: fixture.isPlacementContext, burnIn: true, fixtureKey: fixture.key },
    ],
  );

  await tx.unsafe(
    `
    INSERT INTO match_players (
      match_id,
      user_id,
      seat,
      total_points,
      correct_answers,
      goals,
      penalty_goals
    )
    VALUES
      ($1, $2, 1, $3, $4, $5, $6),
      ($1, $7, 2, $8, $9, $10, $11)
    `,
    [
      fixture.matchId,
      fixture.botAUserId,
      fixture.scoreA.totalPoints,
      fixture.scoreA.correctAnswers,
      fixture.scoreA.goals,
      fixture.scoreA.penaltyGoals,
      fixture.botBUserId,
      fixture.scoreB.totalPoints,
      fixture.scoreB.correctAnswers,
      fixture.scoreB.goals,
      fixture.scoreB.penaltyGoals,
    ],
  );

  const profiles = await tx.unsafe<LockedRankedProfile[]>(
    `
    SELECT
      user_id,
      rp,
      placement_status,
      placement_required,
      placement_played,
      placement_wins,
      placement_seed_rp,
      placement_perf_sum,
      placement_points_for_sum,
      placement_points_against_sum,
      current_win_streak
    FROM ranked_profiles
    WHERE user_id IN ($1, $2)
    FOR UPDATE
    `,
    [fixture.botAUserId, fixture.botBUserId],
  );
  const profileByUserId = new Map(profiles.map((profile) => [profile.user_id, profile]));
  const profileA = profileByUserId.get(fixture.botAUserId);
  const profileB = profileByUserId.get(fixture.botBUserId);
  if (!profileA || !profileB) {
    throw new Error(`Burn-in fixture ${fixture.matchId} is missing a pristine ranked profile`);
  }

  const participants = settleFixture(fixture, profileA, profileB);

  for (const participant of participants) {
    const settlement = participant.settlement;
    await tx.unsafe(
      `
      UPDATE ranked_profiles
      SET
        rp = $1,
        tier = $2,
        placement_status = $3,
        placement_played = $4,
        placement_wins = $5,
        placement_seed_rp = $6,
        placement_perf_sum = $7,
        placement_points_for_sum = $8,
        placement_points_against_sum = $9,
        current_win_streak = $10,
        last_ranked_match_at = $11,
        updated_at = $11
      WHERE user_id = $12
      `,
      [
        settlement.newRp,
        settlement.newTier,
        settlement.placementStatus,
        settlement.placementPlayed,
        settlement.placementWins,
        settlement.placementSeedRp,
        settlement.placementPerfSum,
        settlement.placementPointsForSum,
        settlement.placementPointsAgainstSum,
        settlement.currentWinStreak,
        matchAt,
        participant.userId,
      ],
    );

    await tx.unsafe(
      `
      INSERT INTO ranked_rp_changes (
        match_id,
        user_id,
        opponent_user_id,
        opponent_is_ai,
        old_rp,
        delta_rp,
        new_rp,
        result,
        is_placement,
        placement_game_no,
        placement_anchor_rp,
        placement_perf_score,
        calculation_method,
        coins_awarded,
        created_at
      )
      VALUES (
        $1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13
      )
      `,
      [
        fixture.matchId,
        participant.userId,
        participant.opponentUserId,
        participant.profile.rp,
        settlement.deltaRp,
        settlement.newRp,
        settlement.result,
        settlement.isPlacement,
        settlement.placementGameNo,
        settlement.placementAnchorRp,
        settlement.placementPerfScore,
        settlement.calculationMethod,
        matchAt,
      ],
    );
  }

  await tx.unsafe(
    `
    INSERT INTO user_mode_match_stats (
      user_id,
      mode,
      games_played,
      wins,
      losses,
      draws,
      last_match_at,
      updated_at
    )
    VALUES
      ($1, 'ranked', 1, $2, $3, 0, $4, NOW()),
      ($5, 'ranked', 1, $6, $7, 0, $4, NOW())
    ON CONFLICT (user_id, mode) DO UPDATE SET
      games_played = user_mode_match_stats.games_played + 1,
      wins = user_mode_match_stats.wins + EXCLUDED.wins,
      losses = user_mode_match_stats.losses + EXCLUDED.losses,
      draws = user_mode_match_stats.draws + EXCLUDED.draws,
      last_match_at = COALESCE(
        GREATEST(user_mode_match_stats.last_match_at, EXCLUDED.last_match_at),
        EXCLUDED.last_match_at,
        user_mode_match_stats.last_match_at
      ),
      updated_at = NOW()
    `,
    [
      participants[0].userId,
      participants[0].settlement.result === 'win' ? 1 : 0,
      participants[0].settlement.result === 'loss' ? 1 : 0,
      fixture.endedAt,
      participants[1].userId,
      participants[1].settlement.result === 'win' ? 1 : 0,
      participants[1].settlement.result === 'loss' ? 1 : 0,
    ],
  );

  for (const participant of participants) {
    const xpDelta = getMatchXpReward({
      mode: 'ranked',
      result: participant.settlement.result,
      isForfeitLoss: false,
    });
    await tx.unsafe(
      `
      WITH inserted AS (
        INSERT INTO user_xp_events (
          user_id,
          source_type,
          source_key,
          xp_delta,
          created_at
        )
        VALUES ($1, 'match_result', $2, $3, $4)
        ON CONFLICT (user_id, source_type, source_key) DO NOTHING
        RETURNING xp_delta
      )
      UPDATE users
      SET total_xp = total_xp + COALESCE((SELECT xp_delta FROM inserted), 0)
      WHERE id = $1
      `,
      [participant.userId, fixture.matchId, xpDelta, matchAt],
    );
  }

  // Burn-in deliberately invokes NO side-effect services — not achievements, and
  // not notifications/quests/streak-rewards/analytics either.
  //
  // WHY (semantics, not performance): these fixtures are backdated synthetic
  // history fabricated to give a fresh bot roster a plausible ladder position.
  // They are not gameplay that happened. Live services interpret a completed
  // match as a real-time event a player just earned, so running them here would
  // manufacture unlocks and notifications for matches nobody played. Burn-in
  // therefore writes ONLY the ledger of record it is meant to seed: matches,
  // match_players, ranked_profiles, ranked_rp_changes, user_mode_match_stats and
  // the match XP events — all as plain SQL on the caller's transaction, so a
  // chunk is exactly reproducible and rolls back atomically.
  //
  // Keeping the write path service-free also keeps it deterministic: the planner
  // solves seeds against a model of these rows alone, so any extra service
  // mutating them would put the executed ladder out of step with the plan.
  //
  // Secondary (measured, loopback, 5,999 fixtures): evaluating achievements costs
  // 20.5s vs 8.7s, ~2.4x. Real but not itself prohibitive — it is not the reason
  // for this change, and it is NOT what stalled the first staging execute.
}

/**
 * BATCHED chunk writer — the same fixture row-set as writeFixtureInTx, but the
 * whole chunk collapsed into a handful of statements.
 *
 * WHY (issue #343): writeFixtureInTx issues ~7 sequential statements per
 * fixture. A transaction connection runs one query at a time, so postgres.js
 * cannot pipeline them: every statement costs a full round-trip. On loopback
 * that is ~1ms/fixture; over a WAN link to the Supabase pooler it is ~1s/fixture
 * (~7 x ~30ms RTT + overhead), turning a 6k-fixture burn-in into ~3 hours of
 * mostly-idle waiting with chunk transactions held open the entire time.
 *
 * The collapse is only sound because the per-fixture writer never READS its own
 * writes through SQL: each fixture re-SELECTs both profiles, but within one
 * chunk transaction those reads only ever return what THIS transaction already
 * wrote. So the identical row states can be folded in memory instead, and the
 * ledger written once at chunk end.
 *
 * Equivalence rules this function is built around (each one is load-bearing):
 *   1. Both seats of a fixture settle from the SAME pre-fixture snapshot —
 *      neither observes the other's update (see settleFixture).
 *   2. ranked_rp_changes.old_rp / placement_anchor_rp / opponentIsStronger read
 *      the PRE-fixture state, so ledger rows are materialized BEFORE the profile
 *      map is advanced (mutating first would make old_rp == new_rp).
 *   3. ranked_profiles gets ONE final row-state per bot; last_ranked_match_at
 *      and updated_at carry that bot's LAST fixture timestamp (not NOW()),
 *      exactly as the sequential path leaves them.
 *   4. user_mode_match_stats MUST be pre-aggregated per bot: two rows with the
 *      same conflict key in one INSERT ... ON CONFLICT DO UPDATE raises
 *      "cannot affect row a second time".
 *   5. users.total_xp is updated for EVERY touched bot — including bots whose XP
 *      events all conflicted (adding 0) — because the sequential path always ran
 *      UPDATE users, and users has a BEFORE UPDATE updated_at trigger. Skipping
 *      the no-op update would leave a different updated_at.
 */
export async function writeFixtureChunkInTx(
  tx: TransactionSql,
  fixtures: readonly PlannedFixture[],
): Promise<void> {
  if (fixtures.length === 0) return;

  for (const fixture of fixtures) {
    if (fixture.botAUserId === fixture.botBUserId) {
      throw new Error(`burn-in fixture ${fixture.matchId} pairs a bot with itself`);
    }
  }

  // ── 1. ONE bulk locked read of every profile this chunk touches ────────────
  // Ordered by user_id for a deterministic lock order. The sequential path took
  // the same locks fixture-by-fixture; taking them up front is a superset held
  // for the same transaction, so it cannot change the committed result.
  const chunkUserIds = [...new Set(fixtures.flatMap((f) => [f.botAUserId, f.botBUserId]))].sort();
  const lockedProfiles = await tx.unsafe<LockedRankedProfile[]>(
    `
    SELECT
      user_id,
      rp,
      placement_status,
      placement_required,
      placement_played,
      placement_wins,
      placement_seed_rp,
      placement_perf_sum,
      placement_points_for_sum,
      placement_points_against_sum,
      current_win_streak
    FROM ranked_profiles
    WHERE user_id = ANY($1::uuid[])
    ORDER BY user_id
    FOR UPDATE
    `,
    [chunkUserIds],
  );
  const profileByUserId = new Map(lockedProfiles.map((p) => [p.user_id, p]));
  for (const userId of chunkUserIds) {
    if (!profileByUserId.get(userId)) {
      throw new Error(`Burn-in chunk is missing a pristine ranked profile for bot ${userId}`);
    }
  }

  // ── 2. Fold the chunk in memory, in chronological fixture order ────────────
  const matchRows: MatchRow[] = [];
  const playerRows: MatchPlayerRow[] = [];
  const rpChangeRows: RpChangeRow[] = [];
  const finalProfileByUserId = new Map<string, FinalProfileRow>();
  const statsByUserId = new Map<string, StatsAccumulator>();
  const xpRows: XpEventRow[] = [];

  for (const fixture of fixtures) {
    const matchAt = fixture.endedAt;
    const beforeA = profileByUserId.get(fixture.botAUserId)!;
    const beforeB = profileByUserId.get(fixture.botBUserId)!;

    // Rule 1: both seats settle from the pre-fixture snapshot of BOTH profiles.
    const participants = settleFixture(fixture, beforeA, beforeB);

    matchRows.push({
      id: fixture.matchId,
      winnerUserId: fixture.winnerUserId,
      startedAt: fixture.startedAt,
      endedAt: fixture.endedAt,
      categoryAId: fixture.categoryAId,
      categoryBId: fixture.categoryBId,
      statePayload: { winnerDecisionMethod: fixture.decision },
      rankedContext: { isPlacement: fixture.isPlacementContext, burnIn: true, fixtureKey: fixture.key },
    });

    playerRows.push(
      {
        matchId: fixture.matchId,
        userId: fixture.botAUserId,
        seat: 1,
        totalPoints: fixture.scoreA.totalPoints,
        correctAnswers: fixture.scoreA.correctAnswers,
        goals: fixture.scoreA.goals,
        penaltyGoals: fixture.scoreA.penaltyGoals,
      },
      {
        matchId: fixture.matchId,
        userId: fixture.botBUserId,
        seat: 2,
        totalPoints: fixture.scoreB.totalPoints,
        correctAnswers: fixture.scoreB.correctAnswers,
        goals: fixture.scoreB.goals,
        penaltyGoals: fixture.scoreB.penaltyGoals,
      },
    );

    // Rule 2: materialize every ledger row from the PRE-fixture state before
    // advancing either profile in the map.
    for (const participant of participants) {
      const settlement = participant.settlement;
      rpChangeRows.push({
        matchId: fixture.matchId,
        userId: participant.userId,
        opponentUserId: participant.opponentUserId,
        oldRp: participant.profile.rp,
        deltaRp: settlement.deltaRp,
        newRp: settlement.newRp,
        result: settlement.result,
        isPlacement: settlement.isPlacement,
        placementGameNo: settlement.placementGameNo,
        placementAnchorRp: settlement.placementAnchorRp,
        placementPerfScore: settlement.placementPerfScore,
        calculationMethod: settlement.calculationMethod,
        createdAt: matchAt,
      });

      xpRows.push({
        userId: participant.userId,
        sourceKey: fixture.matchId,
        xpDelta: getMatchXpReward({
          mode: 'ranked',
          result: settlement.result,
          isForfeitLoss: false,
        }),
        createdAt: matchAt,
      });

      const stats = statsByUserId.get(participant.userId) ?? {
        userId: participant.userId,
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        lastMatchAt: fixture.endedAt,
      };
      stats.gamesPlayed += 1;
      if (settlement.result === 'win') stats.wins += 1;
      if (settlement.result === 'loss') stats.losses += 1;
      // Mirrors the sequential GREATEST(existing, EXCLUDED) per fixture.
      if (fixture.endedAt > stats.lastMatchAt) stats.lastMatchAt = fixture.endedAt;
      statsByUserId.set(participant.userId, stats);
    }

    // Now advance both profiles — the next fixture reads exactly what the
    // sequential writer's next SELECT would have returned.
    for (const participant of participants) {
      const next = nextProfileState(participant.profile, participant.settlement);
      profileByUserId.set(participant.userId, next);
      // Rule 3: LAST fixture wins, carrying that fixture's timestamp.
      finalProfileByUserId.set(participant.userId, {
        ...next,
        tier: participant.settlement.newTier,
        lastRankedMatchAt: matchAt,
      });
    }
  }

  // ── 3. Flush: a handful of statements for the whole chunk ──────────────────
  await insertMatches(tx, matchRows);
  await insertMatchPlayers(tx, playerRows);
  await updateRankedProfiles(tx, [...finalProfileByUserId.values()]);
  await insertRpChanges(tx, rpChangeRows);
  await upsertModeMatchStats(tx, [...statsByUserId.values()]);
  await insertXpEventsAndBumpTotals(tx, xpRows);

  // Burn-in deliberately invokes NO side-effect services — see the note at the
  // end of writeFixtureInTx. Batching changes only the statement count, never
  // the set of tables written.
}

interface MatchRow {
  id: string;
  winnerUserId: string;
  startedAt: Date;
  endedAt: Date;
  categoryAId: string;
  categoryBId: string;
  statePayload: unknown;
  rankedContext: unknown;
}

interface MatchPlayerRow {
  matchId: string;
  userId: string;
  seat: number;
  totalPoints: number;
  correctAnswers: number;
  goals: number;
  penaltyGoals: number;
}

interface RpChangeRow {
  matchId: string;
  userId: string;
  opponentUserId: string;
  oldRp: number;
  deltaRp: number;
  newRp: number;
  result: 'win' | 'loss';
  isPlacement: boolean;
  placementGameNo: number | null;
  placementAnchorRp: number | null;
  placementPerfScore: number | null;
  calculationMethod: string;
  createdAt: Date;
}

interface FinalProfileRow extends LockedRankedProfile {
  tier: string;
  lastRankedMatchAt: Date;
}

interface StatsAccumulator {
  userId: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  lastMatchAt: Date;
}

interface XpEventRow {
  userId: string;
  sourceKey: string;
  xpDelta: number;
  createdAt: Date;
}

/**
 * Guard against a silently misaligned unnest: postgres pads shorter arrays with
 * NULL rather than erroring, which would quietly null out trailing rows.
 */
/**
 * Bind a timestamp column as ISO-8601 text.
 *
 * postgres.js infers a parameter's type from the first array element, so a raw
 * Date[] is sent as the SCALAR timestamptz OID and `$n::timestamptz[]` then
 * fails with "cannot cast type timestamp with time zone to timestamp with time
 * zone[]". Text binds cleanly and postgres parses it to the identical instant
 * (ISO-8601 always carries the UTC offset).
 */
function tsColumn(rows: readonly Date[]): string[] {
  return rows.map((d) => d.toISOString());
}

function assertAligned(columns: readonly unknown[][], expected: number, label: string): void {
  for (const column of columns) {
    if (column.length !== expected) {
      throw new Error(`burn-in batched ${label}: misaligned column (${column.length} != ${expected})`);
    }
  }
}

async function insertMatches(tx: TransactionSql, rows: readonly MatchRow[]): Promise<void> {
  if (rows.length === 0) return;
  const cols = [
    rows.map((r) => r.id),
    rows.map((r) => r.winnerUserId),
    tsColumn(rows.map((r) => r.startedAt)),
    tsColumn(rows.map((r) => r.endedAt)),
    rows.map((r) => r.categoryAId),
    rows.map((r) => r.categoryBId),
    // postgres.js binds a JS object to a jsonb OBJECT; JSON.stringify'ing each
    // element would store a jsonb STRING (double-encoded) instead.
    rows.map((r) => r.statePayload),
    rows.map((r) => r.rankedContext),
  ];
  assertAligned(cols, rows.length, 'matches');
  await tx.unsafe(
    `
    INSERT INTO matches (
      id, mode, status, winner_user_id, is_dev, started_at, ended_at,
      category_a_id, category_b_id, total_questions, current_q_index,
      state_payload, ranked_context
    )
    SELECT
      src.id, 'ranked', 'completed', src.winner_user_id, false,
      src.started_at, src.ended_at, src.category_a_id, src.category_b_id, 12, 12,
      src.state_payload, src.ranked_context
    FROM UNNEST(
      $1::uuid[], $2::uuid[], $3::timestamptz[], $4::timestamptz[],
      $5::uuid[], $6::uuid[], $7::jsonb[], $8::jsonb[]
    ) AS src(
      id, winner_user_id, started_at, ended_at,
      category_a_id, category_b_id, state_payload, ranked_context
    )
    `,
    cols,
  );
}

async function insertMatchPlayers(tx: TransactionSql, rows: readonly MatchPlayerRow[]): Promise<void> {
  if (rows.length === 0) return;
  const cols = [
    rows.map((r) => r.matchId),
    rows.map((r) => r.userId),
    rows.map((r) => r.seat),
    rows.map((r) => r.totalPoints),
    rows.map((r) => r.correctAnswers),
    rows.map((r) => r.goals),
    rows.map((r) => r.penaltyGoals),
  ];
  assertAligned(cols, rows.length, 'match_players');
  await tx.unsafe(
    `
    INSERT INTO match_players (
      match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals
    )
    SELECT src.match_id, src.user_id, src.seat, src.total_points, src.correct_answers, src.goals, src.penalty_goals
    FROM UNNEST(
      $1::uuid[], $2::uuid[], $3::smallint[], $4::integer[], $5::integer[], $6::integer[], $7::integer[]
    ) AS src(match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals)
    `,
    cols,
  );
}

async function updateRankedProfiles(tx: TransactionSql, rows: readonly FinalProfileRow[]): Promise<void> {
  if (rows.length === 0) return;
  const cols = [
    rows.map((r) => r.user_id),
    rows.map((r) => r.rp),
    rows.map((r) => r.tier),
    rows.map((r) => r.placement_status),
    rows.map((r) => r.placement_played),
    rows.map((r) => r.placement_wins),
    rows.map((r) => r.placement_seed_rp),
    rows.map((r) => r.placement_perf_sum),
    rows.map((r) => r.placement_points_for_sum),
    rows.map((r) => r.placement_points_against_sum),
    rows.map((r) => r.current_win_streak),
    tsColumn(rows.map((r) => r.lastRankedMatchAt)),
  ];
  assertAligned(cols, rows.length, 'ranked_profiles');
  const updated = await tx.unsafe<{ user_id: string }[]>(
    `
    UPDATE ranked_profiles AS profile
    SET
      rp = src.rp,
      tier = src.tier,
      placement_status = src.placement_status,
      placement_played = src.placement_played,
      placement_wins = src.placement_wins,
      placement_seed_rp = src.placement_seed_rp,
      placement_perf_sum = src.placement_perf_sum,
      placement_points_for_sum = src.placement_points_for_sum,
      placement_points_against_sum = src.placement_points_against_sum,
      current_win_streak = src.current_win_streak,
      last_ranked_match_at = src.last_ranked_match_at,
      updated_at = src.last_ranked_match_at
    FROM UNNEST(
      $1::uuid[], $2::integer[], $3::text[], $4::text[], $5::smallint[], $6::smallint[],
      $7::integer[], $8::integer[], $9::integer[], $10::integer[], $11::smallint[], $12::timestamptz[]
    ) AS src(
      user_id, rp, tier, placement_status, placement_played, placement_wins,
      placement_seed_rp, placement_perf_sum, placement_points_for_sum,
      placement_points_against_sum, current_win_streak, last_ranked_match_at
    )
    WHERE profile.user_id = src.user_id
    RETURNING profile.user_id
    `,
    cols,
  );
  if (updated.length !== rows.length) {
    throw new Error(`burn-in batched profile update touched ${updated.length}/${rows.length} rows`);
  }
}

async function insertRpChanges(tx: TransactionSql, rows: readonly RpChangeRow[]): Promise<void> {
  if (rows.length === 0) return;
  const cols = [
    rows.map((r) => r.matchId),
    rows.map((r) => r.userId),
    rows.map((r) => r.opponentUserId),
    rows.map((r) => r.oldRp),
    rows.map((r) => r.deltaRp),
    rows.map((r) => r.newRp),
    rows.map((r) => r.result),
    // Bound as 0/1 integers, not booleans: postgres.js infers the SCALAR bool
    // OID from a boolean[] (making ::boolean[] an illegal cast), and every text
    // workaround silently binds as FALSE. Cast back to boolean in SQL.
    rows.map((r) => (r.isPlacement ? 1 : 0)),
    rows.map((r) => r.placementGameNo),
    rows.map((r) => r.placementAnchorRp),
    rows.map((r) => r.placementPerfScore),
    rows.map((r) => r.calculationMethod),
    tsColumn(rows.map((r) => r.createdAt)),
  ];
  assertAligned(cols, rows.length, 'ranked_rp_changes');
  await tx.unsafe(
    `
    INSERT INTO ranked_rp_changes (
      match_id, user_id, opponent_user_id, opponent_is_ai, old_rp, delta_rp, new_rp,
      result, is_placement, placement_game_no, placement_anchor_rp, placement_perf_score,
      calculation_method, coins_awarded, created_at
    )
    SELECT
      src.match_id, src.user_id, src.opponent_user_id, true, src.old_rp, src.delta_rp, src.new_rp,
      src.result, src.is_placement <> 0, src.placement_game_no, src.placement_anchor_rp,
      src.placement_perf_score, src.calculation_method, 0, src.created_at
    FROM UNNEST(
      $1::uuid[], $2::uuid[], $3::uuid[], $4::integer[], $5::integer[], $6::integer[],
      $7::text[], $8::integer[], $9::integer[], $10::integer[], $11::integer[],
      $12::text[], $13::timestamptz[]
    ) AS src(
      match_id, user_id, opponent_user_id, old_rp, delta_rp, new_rp,
      result, is_placement, placement_game_no, placement_anchor_rp, placement_perf_score,
      calculation_method, created_at
    )
    `,
    cols,
  );
}

async function upsertModeMatchStats(tx: TransactionSql, rows: readonly StatsAccumulator[]): Promise<void> {
  if (rows.length === 0) return;
  // Pre-aggregated per bot: two rows with the same (user_id, mode) conflict key
  // in one statement would raise "cannot affect row a second time".
  const cols = [
    rows.map((r) => r.userId),
    rows.map((r) => r.gamesPlayed),
    rows.map((r) => r.wins),
    rows.map((r) => r.losses),
    tsColumn(rows.map((r) => r.lastMatchAt)),
  ];
  assertAligned(cols, rows.length, 'user_mode_match_stats');
  await tx.unsafe(
    `
    INSERT INTO user_mode_match_stats (
      user_id, mode, games_played, wins, losses, draws, last_match_at, updated_at
    )
    SELECT src.user_id, 'ranked', src.games_played, src.wins, src.losses, 0, src.last_match_at, NOW()
    FROM UNNEST(
      $1::uuid[], $2::integer[], $3::integer[], $4::integer[], $5::timestamptz[]
    ) AS src(user_id, games_played, wins, losses, last_match_at)
    ON CONFLICT (user_id, mode) DO UPDATE SET
      games_played = user_mode_match_stats.games_played + EXCLUDED.games_played,
      wins = user_mode_match_stats.wins + EXCLUDED.wins,
      losses = user_mode_match_stats.losses + EXCLUDED.losses,
      draws = user_mode_match_stats.draws + EXCLUDED.draws,
      last_match_at = COALESCE(
        GREATEST(user_mode_match_stats.last_match_at, EXCLUDED.last_match_at),
        EXCLUDED.last_match_at,
        user_mode_match_stats.last_match_at
      ),
      updated_at = NOW()
    `,
    cols,
  );
}

async function insertXpEventsAndBumpTotals(tx: TransactionSql, rows: readonly XpEventRow[]): Promise<void> {
  if (rows.length === 0) return;
  const cols = [
    rows.map((r) => r.userId),
    rows.map((r) => r.sourceKey),
    rows.map((r) => r.xpDelta),
    tsColumn(rows.map((r) => r.createdAt)),
  ];
  assertAligned(cols, rows.length, 'user_xp_events');
  // Distinct touched bots, so users.total_xp is updated for EVERY bot in the
  // chunk — including one whose events all conflicted (adding 0). The sequential
  // path always ran UPDATE users, and users has a BEFORE UPDATE updated_at
  // trigger, so skipping the no-op would leave a different updated_at.
  const touchedUserIds = [...new Set(rows.map((r) => r.userId))].sort();
  await tx.unsafe(
    `
    WITH inserted AS (
      INSERT INTO user_xp_events (user_id, source_type, source_key, xp_delta, created_at)
      SELECT src.user_id, 'match_result', src.source_key, src.xp_delta, src.created_at
      FROM UNNEST($1::uuid[], $2::text[], $3::integer[], $4::timestamptz[])
        AS src(user_id, source_key, xp_delta, created_at)
      ON CONFLICT (user_id, source_type, source_key) DO NOTHING
      RETURNING user_id, xp_delta
    ),
    gained AS (
      SELECT user_id, SUM(xp_delta)::integer AS xp_delta
      FROM inserted
      GROUP BY user_id
    )
    UPDATE users
    SET total_xp = total_xp + COALESCE(gained.xp_delta, 0)
    FROM UNNEST($5::uuid[]) AS touched(user_id)
    LEFT JOIN gained ON gained.user_id = touched.user_id
    WHERE users.id = touched.user_id
    `,
    [...cols, touchedUserIds],
  );
}
