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
import { computeParticipantSettlement, tierFromRp } from '../../src/modules/ranked/season-rp-formula.js';
import type { PlacementStatus } from '../../src/modules/ranked/ranked.types.js';
import type { PlannedFixture } from './types.js';
import { placementWinsForBand, type SeededBot } from './s2-distribution.js';

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
