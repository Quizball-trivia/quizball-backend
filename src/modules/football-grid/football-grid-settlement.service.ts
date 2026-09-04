import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
import { sql, type TransactionSql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import { getMatchXpReward } from '../progression/progression.logic.js';
import { progressionRepo } from '../progression/progression.repo.js';
import { reservationService } from '../synthetic-bots/reservation.service.js';
import { footballGridBotGovernorService } from './football-grid-bot-governor.service.js';

// Ranked parity: same win/loss coin payout as RANKED_WIN_COINS /
// RANKED_LOSS_COINS in season-rp-formula.ts (a draw pays the non-win amount,
// exactly as a ranked non-win does).
const COIN_REWARDS = { win: 700, draw: 250, loss: 250 } as const;
// Tic Tac Toe Points — the grid's own leaderboard currency, mirroring auction
// AP amounts (1st 50 / 2nd 30 / 3rd 10) mapped onto 1v1 results.
const TP_REWARDS = { win: 50, draw: 30, loss: 10 } as const;
// Cap scaled with the ranked-parity amounts so a player can still have the
// same ~5 rewarded matches per day as under the old 300-coin win.
const COIN_DAILY_CAP = 3_500;
const HUMAN_PAIR_DAILY_LIMIT = 3;
const BOT_MATCH_DAILY_LIMIT = 5;
const WORKER_INTERVAL_MS = 5_000;
const WORKER_BATCH_SIZE = 20;

interface SettlementRow {
  outbox_id: string;
  match_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempt_count: number;
  base_status: string;
  origin: string;
  winner_user_id: string | null;
  completion_reason: string | null;
  match_created_at: string;
  ended_at: string | null;
}

interface ParticipantFacts {
  user_id: string;
  is_bot: boolean;
  claim_count: number;
  answer_turn_count: number;
}

interface RewardRiskDecision {
  decision: 'clear' | 'held' | 'ineligible';
  reason: string;
  signals: Record<string, unknown>;
}

export interface FootballGridRewardResult {
  xp: number;
  coins: number;
  /** Tic Tac Toe Points — the mode leaderboard currency. */
  tp: number;
  /** Backward-compatible primary reason. TP is the competitive progression
   * reward, so this mirrors tpEligibilityReason. */
  eligibilityReason: string;
  coinEligibilityReason: string;
  tpEligibilityReason: string;
}

let workerTimer: NodeJS.Timeout | null = null;
let workerRunning = false;

function isForfeitReason(reason: string | null): boolean {
  return reason === 'forfeit' || reason === 'no_action_timeouts' || reason === 'disconnect_timeout';
}

async function readParticipants(tx: TransactionSql, matchId: string): Promise<ParticipantFacts[]> {
  return tx.unsafe<ParticipantFacts[]>(
    `SELECT p.user_id, p.is_bot,
            (SELECT count(*)::int FROM football_grid_claims c
              WHERE c.match_id = p.match_id AND c.claimant_user_id = p.user_id) AS claim_count,
            (SELECT count(DISTINCT a.turn_number)::int FROM football_grid_attempts a
              WHERE a.match_id = p.match_id AND a.actor_user_id = p.user_id
                AND a.cell_index IS NOT NULL) AS answer_turn_count
       FROM football_grid_participants p
      WHERE p.match_id = $1
      ORDER BY p.user_id`,
    [matchId],
  );
}

async function lockBudgets(tx: TransactionSql, userIds: string[]): Promise<void> {
  for (const userId of [...userIds].sort()) {
    await tx.unsafe(
      `INSERT INTO football_grid_reward_budgets (user_id)
       VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  }
  if (userIds.length > 0) {
    await tx.unsafe(
      `SELECT user_id FROM football_grid_reward_budgets
        WHERE user_id = ANY($1::uuid[]) ORDER BY user_id FOR UPDATE`,
      [[...userIds].sort()],
    );
  }
}

async function countRecentHumanPair(
  tx: TransactionSql,
  userId: string,
  opponentId: string,
  currentMatchId: string,
): Promise<number> {
  const rows = await tx.unsafe<Array<{ count: string }>>(
    `SELECT count(*)::text AS count
       FROM football_grid_matches gm
      WHERE gm.origin = 'random'
        AND gm.status IN ('completed', 'forfeited')
        AND gm.match_id <> $3
        AND gm.ended_at >= now() - interval '24 hours'
        AND EXISTS (SELECT 1 FROM football_grid_participants p WHERE p.match_id = gm.match_id AND p.user_id = $1)
        AND EXISTS (SELECT 1 FROM football_grid_participants p WHERE p.match_id = gm.match_id AND p.user_id = $2)`,
    [userId, opponentId, currentMatchId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function rollingBudget(tx: TransactionSql, userId: string): Promise<{ coins: number; botMatches: number }> {
  const rows = await tx.unsafe<Array<{ coins: string; bot_matches: string }>>(
    `SELECT
       COALESCE((SELECT sum(original.amount)
                   FROM football_grid_coin_events original
                  WHERE original.user_id = $1
                    AND original.reversal_of IS NULL
                    AND original.status IN ('committed', 'held')
                    AND (
                      original.status = 'held'
                      OR (original.status = 'committed' AND original.credited_at >= now() - interval '24 hours')
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM football_grid_coin_events reversal
                       WHERE reversal.reversal_of = original.id
                    )), 0)::text AS coins,
       COALESCE((SELECT count(*) FROM football_grid_reward_eligibility
                 WHERE user_id = $1 AND opponent_type = 'bot'
                   AND (
                     decision IN ('eligible','held')
                     OR points_decision IN ('eligible','held')
                   )
                   AND evaluated_at >= now() - interval '24 hours'), 0)::text AS bot_matches`,
    [userId],
  );
  return { coins: Number(rows[0]?.coins ?? 0), botMatches: Number(rows[0]?.bot_matches ?? 0) };
}

async function readRiskDecision(
  tx: TransactionSql,
  matchId: string,
  userId: string,
): Promise<RewardRiskDecision | null> {
  const rows = await tx.unsafe<RewardRiskDecision[]>(
    `SELECT decision, reason, signals
       FROM football_grid_reward_risk_decisions
      WHERE match_id = $1 AND user_id = $2
      ORDER BY evaluator_version DESC
      LIMIT 1`,
    [matchId, userId],
  );
  return rows[0] ?? null;
}

async function evaluateRiskDecision(
  tx: TransactionSql,
  matchId: string,
  userId: string,
  opponentId: string,
  repeatedPairCount: number,
): Promise<RewardRiskDecision> {
  const existing = await readRiskDecision(tx, matchId, userId);
  if (existing) return existing;
  const observations = await tx.unsafe<Array<{
    user_id: string;
    device_hash: string | null;
    network_hash: string | null;
  }>>(
    `SELECT user_id, device_hash, network_hash
       FROM football_grid_reward_risk_observations
      WHERE match_id = $1 AND user_id = ANY($2::uuid[])`,
    [matchId, [userId, opponentId]],
  );
  const mine = observations.find((observation) => observation.user_id === userId);
  const opponent = observations.find((observation) => observation.user_id === opponentId);
  const velocityRows = await tx.unsafe<Array<{ count: string }>>(
    `SELECT count(*)::text AS count
      FROM football_grid_reward_eligibility
      WHERE user_id = $1 AND evaluated_at >= now() - interval '10 minutes'
        AND (
          decision IN ('eligible', 'held')
          OR points_decision IN ('eligible', 'held')
        )`,
    [userId],
  );
  const velocity = Number(velocityRows[0]?.count ?? 0);
  let decision: RewardRiskDecision['decision'] = 'clear';
  let reason = 'automated_clear';
  if (!mine?.network_hash) {
    decision = 'held';
    reason = 'missing_trusted_network_signal';
  } else if (mine.device_hash && opponent?.device_hash === mine.device_hash) {
    decision = 'held';
    reason = 'linked_device';
  } else if (
    repeatedPairCount > 0
    && mine.network_hash
    && opponent?.network_hash === mine.network_hash
  ) {
    decision = 'held';
    reason = 'linked_network_repeat';
  } else if (velocity >= 4) {
    decision = 'held';
    reason = 'reward_velocity';
  }
  const signals = {
    hasDeviceSignal: Boolean(mine?.device_hash),
    hasNetworkSignal: Boolean(mine?.network_hash),
    sameDevice: Boolean(mine?.device_hash && opponent?.device_hash === mine.device_hash),
    sameNetwork: Boolean(mine?.network_hash && opponent?.network_hash === mine.network_hash),
    repeatedPairCount,
    rewardedMatchesLast10m: velocity,
  };
  await tx.unsafe(
    `INSERT INTO football_grid_reward_risk_decisions (
       match_id, user_id, evaluator_version, decision, reason, signals, source
     ) VALUES ($1,$2,1,$3,$4,$5::jsonb,'football_grid_internal_v1')
     ON CONFLICT (match_id, user_id, evaluator_version) DO NOTHING`,
    [matchId, userId, decision, reason, sql.json(signals)],
  );
  return { decision, reason, signals };
}

async function settleInTx(tx: TransactionSql, matchId: string): Promise<Map<string, FootballGridRewardResult>> {
  const rows = await tx.unsafe<SettlementRow[]>(
    `SELECT o.id AS outbox_id, o.match_id, o.status, o.attempt_count,
            m.status AS base_status, gm.origin, m.winner_user_id,
            gm.completion_reason, gm.created_at AS match_created_at, gm.ended_at
       FROM football_grid_settlement_outbox o
       JOIN matches m ON m.id = o.match_id
       JOIN football_grid_matches gm ON gm.match_id = o.match_id
      WHERE o.match_id = $1
      FOR UPDATE OF o`,
    [matchId],
  );
  const row = rows[0];
  if (!row) return new Map();
  if (row.status === 'completed') {
    return readSettledRewardsInTx(tx, matchId);
  }
  await tx.unsafe(
    `UPDATE football_grid_settlement_outbox
        SET status = 'processing', attempt_count = attempt_count + 1, last_error = null
      WHERE id = $1`,
    [row.outbox_id],
  );
  const participants = await readParticipants(tx, matchId);
  const humans = participants.filter((participant) => !participant.is_bot);
  const results = new Map<string, FootballGridRewardResult>();
  // Best-of-N: rewards are paid once, on the game that decides the series,
  // for the series result. Earlier games settle as 'series_in_progress'.
  const series = await readSeriesOutcome(tx, matchId);
  if (series?.pending) {
    for (const human of humans) {
      const opponent = participants.find((candidate) => candidate.user_id !== human.user_id);
      await tx.unsafe(
        `INSERT INTO football_grid_reward_eligibility (
           match_id, user_id, evaluator_version, opponent_type, origin,
           participation, decision, reason, points_decision, points_reason
         ) VALUES (
           $1,$2,1,$3,$4,'{}'::jsonb,
           'ineligible','series_in_progress','ineligible','series_in_progress'
         )
         ON CONFLICT (match_id, user_id, evaluator_version) DO NOTHING`,
        [matchId, human.user_id, opponent?.is_bot ? 'bot' : 'human', row.origin],
      );
      results.set(human.user_id, {
        xp: 0,
        coins: 0,
        tp: 0,
        eligibilityReason: 'series_in_progress',
        coinEligibilityReason: 'series_in_progress',
        tpEligibilityReason: 'series_in_progress',
      });
    }
    await markSettledInTx(tx, row.outbox_id, matchId);
    return results;
  }
  if (series && !series.pending) {
    // The deciding game pays for the whole series.
    row.winner_user_id = series.winnerUserId;
    if (series.closedReason && series.closedReason !== 'decided' && series.closedReason !== 'series_draw') {
      row.completion_reason = series.closedReason;
    }
  }
  if (row.base_status !== 'completed' || row.completion_reason === 'loading_no_show' || row.completion_reason === 'simultaneous_disconnect') {
    for (const human of humans) {
      const opponent = participants.find((candidate) => candidate.user_id !== human.user_id);
      await tx.unsafe(
        `INSERT INTO football_grid_reward_eligibility (
           match_id, user_id, evaluator_version, opponent_type, origin,
           participation, decision, reason, points_decision, points_reason
         ) VALUES (
           $1,$2,1,$3,$4,'{}'::jsonb,
           'ineligible','no_contest','ineligible','no_contest'
         )
         ON CONFLICT (match_id, user_id, evaluator_version) DO NOTHING`,
        [matchId, human.user_id, opponent?.is_bot ? 'bot' : 'human', row.origin],
      );
      results.set(human.user_id, {
        xp: 0,
        coins: 0,
        tp: 0,
        eligibilityReason: 'no_contest',
        coinEligibilityReason: 'no_contest',
        tpEligibilityReason: 'no_contest',
      });
    }
  } else {
    await lockBudgets(tx, humans.map((human) => human.user_id));
    const startedAtMs = Date.parse(row.match_created_at);
    const endedAtMs = row.ended_at ? Date.parse(row.ended_at) : Number.NaN;
    const durationMs = Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
      ? Math.max(0, endedAtMs - startedAtMs)
      : null;
    for (const human of [...humans].sort((a, b) => a.user_id.localeCompare(b.user_id))) {
      const isDraw = row.winner_user_id === null;
      const result: 'win' | 'draw' | 'loss' = isDraw ? 'draw' : row.winner_user_id === human.user_id ? 'win' : 'loss';
      const xp = config.FOOTBALL_GRID_XP_ENABLED
        ? getMatchXpReward({ mode: 'friendly', result, isForfeitLoss: result === 'loss' && isForfeitReason(row.completion_reason) })
        : 0;
      if (xp > 0) {
        await progressionRepo.grantXpInTx(tx, {
          userId: human.user_id,
          sourceType: 'match_result',
          sourceKey: matchId,
          xpDelta: xp,
          metadata: { matchId, mode: 'friendly', variant: 'football_grid', result, completionReason: row.completion_reason },
        });
      }
      const opponent = participants.find((candidate) => candidate.user_id !== human.user_id)!;
      const opponentType = opponent.is_bot ? 'bot' : 'human';
      const repeatedPairCount = opponent.is_bot
        ? 0
        : await countRecentHumanPair(tx, human.user_id, opponent.user_id, matchId);
      const budget = await rollingBudget(tx, human.user_id);
      const risk = (config.FOOTBALL_GRID_COINS_ENABLED || config.FOOTBALL_GRID_POINTS_ENABLED)
        && row.origin === 'random'
        ? await evaluateRiskDecision(
            tx,
            matchId,
            human.user_id,
            opponent.user_id,
            repeatedPairCount,
          )
        : await readRiskDecision(tx, matchId, human.user_id);
      const proposedCoins = COIN_REWARDS[result];
      let sharedReason = 'eligible';
      if (opponentType === 'human' && repeatedPairCount >= HUMAN_PAIR_DAILY_LIMIT) sharedReason = 'repeated_pair_cap';
      else if (opponentType === 'bot' && budget.botMatches >= BOT_MATCH_DAILY_LIMIT) sharedReason = 'bot_match_cap';
      else if (result === 'loss' && !(human.claim_count >= 1 || (human.answer_turn_count >= 2 && durationMs !== null && durationMs >= 45_000))) sharedReason = 'insufficient_participation';
      else if (risk?.decision === 'ineligible') sharedReason = `risk_ineligible:${risk.reason}`;
      else if (risk?.decision === 'held') sharedReason = `risk_hold:${risk.reason}`;

      let coinReason = sharedReason;
      if (!config.FOOTBALL_GRID_COINS_ENABLED) coinReason = 'coins_disabled';
      else if (row.origin !== 'random') coinReason = 'friend_match_no_coins';
      else if (isForfeitReason(row.completion_reason)) coinReason = 'forfeit_no_coins';
      else if (budget.coins + proposedCoins > COIN_DAILY_CAP) coinReason = 'daily_coin_cap';

      let pointsReason = sharedReason;
      if (!config.FOOTBALL_GRID_POINTS_ENABLED) pointsReason = 'points_disabled';
      else if (row.origin !== 'random') pointsReason = 'friend_match_no_points';
      else if (isForfeitReason(row.completion_reason)) pointsReason = 'forfeit_no_points';

      const coinDecision = coinReason.startsWith('risk_hold:')
        ? 'held'
        : coinReason === 'eligible'
          ? 'eligible'
          : 'ineligible';
      const pointsDecision = pointsReason.startsWith('risk_hold:')
        ? 'held'
        : pointsReason === 'eligible'
          ? 'eligible'
          : 'ineligible';
      const coinEventAmount = coinDecision === 'eligible' || coinDecision === 'held'
        ? proposedCoins
        : 0;
      const coins = coinDecision === 'eligible' ? proposedCoins : 0;
      const proposedPoints = TP_REWARDS[result];
      const pointEventAmount = pointsDecision === 'eligible' || pointsDecision === 'held'
        ? proposedPoints
        : 0;
      const tp = pointsDecision === 'eligible' ? proposedPoints : 0;
      await tx.unsafe(
        `INSERT INTO football_grid_reward_eligibility (
           match_id, user_id, evaluator_version, opponent_type, origin,
           participation, repeated_pair_count, rolling_coin_total,
           rolling_bot_matches, risk_decision, risk_signals, decision, reason,
           points_decision, points_reason
         ) VALUES ($1,$2,1,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
         ON CONFLICT (match_id, user_id, evaluator_version) DO NOTHING`,
        [
          matchId, human.user_id, opponentType, row.origin,
          sql.json({ claimCount: human.claim_count, answerTurnCount: human.answer_turn_count, durationMs }),
          repeatedPairCount, budget.coins, budget.botMatches,
          risk?.decision ?? 'clear', sql.json((risk?.signals ?? {}) as Json),
          coinDecision, coinReason, pointsDecision, pointsReason,
        ],
      );
      if (coinEventAmount > 0) {
        const inserted = await tx.unsafe<Array<{ amount: number }>>(
          `INSERT INTO football_grid_coin_events (
             match_id, user_id, amount, status, eligibility_reason, credited_at
           ) VALUES ($1,$2,$3,$4,$5,CASE WHEN $4 = 'committed' THEN now() ELSE null END)
           ON CONFLICT (match_id, user_id, reward_type) DO NOTHING
           RETURNING amount`,
          [matchId, human.user_id, coinEventAmount, coinDecision === 'held' ? 'held' : 'committed', coinReason],
        );
        if (inserted[0] && coinDecision === 'eligible') {
          await tx.unsafe(
            `UPDATE users SET coins = coins + $2, updated_at = now() WHERE id = $1`,
            [human.user_id, coins],
          );
        }
      }
      if (pointEventAmount > 0) {
        const inserted = await tx.unsafe<Array<{ amount: number }>>(
          `INSERT INTO football_grid_point_events (
             match_id, user_id, amount, status, eligibility_reason, credited_at
           ) VALUES ($1,$2,$3,$4,$5,CASE WHEN $4 = 'committed' THEN now() ELSE null END)
           ON CONFLICT (match_id, user_id, reward_type) DO NOTHING
           RETURNING amount`,
          [matchId, human.user_id, pointEventAmount, pointsDecision === 'held' ? 'held' : 'committed', pointsReason],
        );
        if (inserted[0] && pointsDecision === 'eligible') {
          await tx.unsafe(
            `UPDATE users
                SET tic_tac_toe_points = tic_tac_toe_points + $2,
                    tic_tac_toe_points_updated_at = now(),
                    updated_at = now()
              WHERE id = $1`,
            [human.user_id, tp],
          );
        }
      }
      results.set(human.user_id, {
        xp,
        coins,
        tp,
        eligibilityReason: pointsReason,
        coinEligibilityReason: coinReason,
        tpEligibilityReason: pointsReason,
      });
      appMetrics.footballGridRewardEligibility.add(1, {
        reason: coinReason,
        origin: row.origin,
        opponent_type: opponentType,
        reward_type: 'coins',
      });
      appMetrics.footballGridRewardEligibility.add(1, {
        reason: pointsReason,
        origin: row.origin,
        opponent_type: opponentType,
        reward_type: 'tp',
      });
    }
  }
  await markSettledInTx(tx, row.outbox_id, matchId);
  return results;
}

async function markSettledInTx(tx: TransactionSql, outboxId: string, matchId: string): Promise<void> {
  await tx.unsafe(
    `UPDATE football_grid_settlement_outbox
        SET status = 'completed', completed_at = now(), next_retry_at = null
      WHERE id = $1`,
    [outboxId],
  );
  await tx.unsafe(
    `UPDATE matches
        SET state_payload = COALESCE(state_payload, '{}'::jsonb)
              || '{"footballGridRewardsSettled":true}'::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [matchId],
  );
}

/**
 * For a match inside a best-of-N series: whether the series is still running
 * (nothing to pay yet) or, on the deciding game, the series result to pay for.
 * Single-game series and legacy matches without a series settle as before.
 */
async function readSeriesOutcome(
  tx: TransactionSql,
  matchId: string,
): Promise<{ pending: boolean; winnerUserId: string | null; closedReason: string | null } | null> {
  const rows = await tx.unsafe<Array<{
    format: string;
    status: string;
    current_match_id: string | null;
    winner_user_id: string | null;
    closed_reason: string | null;
    closed_at: string | null;
  }>>(
    `SELECT s.format, s.status, s.current_match_id, s.winner_user_id, s.closed_reason, s.closed_at
       FROM football_grid_matches gm
       JOIN football_grid_series s ON s.id = gm.series_id
      WHERE gm.match_id = $1`,
    [matchId],
  );
  const series = rows[0];
  if (!series || series.format !== 'bo3') return null;
  // closed_at marks a finished series even while a rematch window keeps the
  // row in 'rematch_pending'.
  if (!series.closed_at) return { pending: true, winnerUserId: null, closedReason: null };
  // Closed on a later game: this earlier game was already settled as in-progress.
  if (series.current_match_id && series.current_match_id !== matchId) {
    return { pending: true, winnerUserId: null, closedReason: null };
  }
  return { pending: false, winnerUserId: series.winner_user_id, closedReason: series.closed_reason };
}

async function readSettledRewardsInTx(
  tx: TransactionSql,
  matchId: string,
): Promise<Map<string, FootballGridRewardResult>> {
  const rows = await tx.unsafe<Array<{
    user_id: string;
    amount: number | null;
    coin_status: string | null;
    point_amount: number | null;
    point_status: string | null;
    xp_delta: number | null;
    coin_reason: string;
    points_reason: string | null;
  }>>(
    `SELECT e.user_id, c.amount, c.status AS coin_status,
            p.amount AS point_amount, p.status AS point_status,
            x.xp_delta, e.reason AS coin_reason, e.points_reason
       FROM football_grid_reward_eligibility e
       LEFT JOIN football_grid_coin_events c ON c.match_id = e.match_id AND c.user_id = e.user_id
          AND c.reversal_of IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM football_grid_coin_events reversal WHERE reversal.reversal_of = c.id
          )
       LEFT JOIN football_grid_point_events p ON p.match_id = e.match_id AND p.user_id = e.user_id
          AND p.reversal_of IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM football_grid_point_events reversal WHERE reversal.reversal_of = p.id
          )
       LEFT JOIN user_xp_events x ON x.user_id = e.user_id
          AND x.source_type = 'match_result' AND x.source_key = e.match_id::text
      WHERE e.match_id = $1 AND e.evaluator_version = 1`,
    [matchId],
  );
  const result = new Map<string, FootballGridRewardResult>();
  for (const row of rows) {
    const pointsReason = row.points_reason ?? 'points_not_recorded';
    result.set(row.user_id, {
      xp: row.xp_delta ?? 0,
      coins: row.coin_status === 'committed' ? row.amount ?? 0 : 0,
      tp: row.point_status === 'committed' ? row.point_amount ?? 0 : 0,
      eligibilityReason: pointsReason,
      coinEligibilityReason: row.coin_reason,
      tpEligibilityReason: pointsReason,
    });
  }
  return result;
}

async function processPending(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const rows = await sql<Array<{ match_id: string }>>`
      SELECT match_id FROM football_grid_settlement_outbox
       WHERE status IN ('pending','failed')
         AND (next_retry_at IS NULL OR next_retry_at <= now())
       ORDER BY created_at
       LIMIT ${WORKER_BATCH_SIZE}
    `;
    for (const row of rows) await footballGridSettlementService.settleMatch(row.match_id);
    await processGovernorBacklog();
  } finally {
    workerRunning = false;
  }
}

async function processGovernorBacklog(): Promise<void> {
  try {
    const matchIds = await footballGridBotGovernorService
      .listUnobservedCompletedMatchIds(WORKER_BATCH_SIZE);
    for (const matchId of matchIds) await processGovernorMatch(matchId);
  } catch (error) {
    logger.error({ error }, 'Football Grid bot governor recovery scan failed');
    appMetrics.footballGridBotGovernorProcessing.add(1, { outcome: 'scan_failed' });
  }
}

async function processGovernorMatch(matchId: string): Promise<void> {
  try {
    const result = await footballGridBotGovernorService.observeCompletedMatch(matchId);
    appMetrics.footballGridBotGovernorProcessing.add(1, {
      outcome: result ? 'observed' : 'skipped_or_replayed',
    });
    if (result) {
      appMetrics.footballGridBotGovernorObservations.add(1, {
        tier: result.botTier,
        model_version: String(result.modelVersion),
        trigger: result.decision.trigger,
      });
    }
  } catch (error) {
    // Governor calibration is deliberately outside the reward/result critical
    // path. The completed settlement remains a durable retry source and the
    // next worker pass will try this match again.
    logger.error({ error, matchId }, 'Football Grid bot governor processing failed');
    appMetrics.footballGridBotGovernorProcessing.add(1, { outcome: 'failed' });
  }
}

export const footballGridSettlementService = {
  async settleMatch(matchId: string): Promise<Map<string, FootballGridRewardResult>> {
    try {
      const rewards = await sql.begin((tx) => settleInTx(tx, matchId)) as Map<string, FootballGridRewardResult>;
      await reservationService.releaseIfSettled(matchId, 'completion');
      appMetrics.footballGridSettlements.add(1, { outcome: 'completed' });
      return rewards;
    } catch (error) {
      logger.error({ error, matchId }, 'Football Grid settlement failed');
      appMetrics.footballGridSettlements.add(1, { outcome: 'failed' });
      await sql`
        UPDATE football_grid_settlement_outbox
           SET status = 'failed', last_error = ${error instanceof Error ? error.message.slice(0, 500) : 'unknown'},
               next_retry_at = now() + interval '5 seconds'
         WHERE match_id = ${matchId} AND status <> 'completed'
      `.catch(() => {});
      return new Map();
    }
  },

  start(): void {
    if (workerTimer) return;
    workerTimer = setInterval(() => void processPending().catch((error) => {
      logger.error({ error }, 'Football Grid settlement worker failed');
    }), WORKER_INTERVAL_MS);
    workerTimer.unref?.();
    void processPending().catch(() => {});
  },
};
