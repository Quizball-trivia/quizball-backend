/**
 * Direct transactional writer for one historical persistent-bot fixture.
 *
 * The caller owns the transaction. Every match, settlement, stats, and XP row
 * is written through that injected transaction, with no live multi-transaction
 * service calls.
 */
import type { TransactionSql } from '../../src/db/index.js';
import { getMatchXpReward } from '../../src/modules/progression/progression.logic.js';
import { computeParticipantSettlement } from '../../src/modules/ranked/season-rp-formula.js';
import { achievementsService } from '../../src/modules/achievements/index.js';
import type { PlacementStatus } from '../../src/modules/ranked/ranked.types.js';
import type { PlannedFixture } from './types.js';

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
      JSON.stringify({ winnerDecisionMethod: fixture.decision }),
      JSON.stringify({
        isPlacement: fixture.isPlacementContext,
        burnIn: true,
        fixtureKey: fixture.key,
      }),
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

  // Achievements: same pipeline as live completion, but driven INSIDE this
  // transaction (tx-aware), backdated, and with analytics suppressed (capability
  // matrix — persistent bots stay out of analytics). The just-written match +
  // stats rows are visible to the evaluation because it uses the same tx.
  await achievementsService.evaluateForMatch(
    fixture.matchId,
    [fixture.botAUserId, fixture.botBUserId],
    'ranked_sim',
    { occurredAt: matchAt, suppressAnalytics: true, tx },
  );
}
