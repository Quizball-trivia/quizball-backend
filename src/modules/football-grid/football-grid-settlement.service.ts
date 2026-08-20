import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
import { sql, type TransactionSql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import { getMatchXpReward } from '../progression/progression.logic.js';
import { progressionRepo } from '../progression/progression.repo.js';
import { reservationService } from '../synthetic-bots/reservation.service.js';

const COIN_REWARDS = { win: 300, draw: 200, loss: 150 } as const;
const COIN_DAILY_CAP = 1_500;
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
  eligibilityReason: string;
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
): Promise<number> {
  const rows = await tx.unsafe<Array<{ count: string }>>(
    `SELECT count(*)::text AS count
       FROM football_grid_matches gm
      WHERE gm.origin = 'random'
        AND gm.status IN ('completed', 'forfeited')
        AND gm.ended_at >= now() - interval '24 hours'
        AND EXISTS (SELECT 1 FROM football_grid_participants p WHERE p.match_id = gm.match_id AND p.user_id = $1)
        AND EXISTS (SELECT 1 FROM football_grid_participants p WHERE p.match_id = gm.match_id AND p.user_id = $2)`,
    [userId, opponentId],
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
                   AND decision IN ('eligible','held')
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
        AND decision IN ('eligible', 'held')`,
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
  if (row.status === 'completed') return readSettledRewardsInTx(tx, matchId);
  await tx.unsafe(
    `UPDATE football_grid_settlement_outbox
        SET status = 'processing', attempt_count = attempt_count + 1, last_error = null
      WHERE id = $1`,
    [row.outbox_id],
  );
  const participants = await readParticipants(tx, matchId);
  const humans = participants.filter((participant) => !participant.is_bot);
  const results = new Map<string, FootballGridRewardResult>();
  if (row.base_status !== 'completed' || row.completion_reason === 'loading_no_show' || row.completion_reason === 'simultaneous_disconnect') {
    for (const human of humans) {
      const opponent = participants.find((candidate) => candidate.user_id !== human.user_id);
      await tx.unsafe(
        `INSERT INTO football_grid_reward_eligibility (
           match_id, user_id, evaluator_version, opponent_type, origin,
           participation, decision, reason
         ) VALUES ($1,$2,1,$3,$4,'{}'::jsonb,'ineligible','no_contest')
         ON CONFLICT (match_id, user_id, evaluator_version) DO NOTHING`,
        [matchId, human.user_id, opponent?.is_bot ? 'bot' : 'human', row.origin],
      );
      results.set(human.user_id, { xp: 0, coins: 0, eligibilityReason: 'no_contest' });
    }
  } else {
    await lockBudgets(tx, humans.map((human) => human.user_id));
    const durationMs = Math.max(0, Date.parse(row.ended_at ?? '') - Date.parse(row.match_created_at));
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
      const repeatedPairCount = opponent.is_bot ? 0 : await countRecentHumanPair(tx, human.user_id, opponent.user_id);
      const budget = await rollingBudget(tx, human.user_id);
      const risk = config.FOOTBALL_GRID_COINS_ENABLED && row.origin === 'random'
        ? await evaluateRiskDecision(
            tx,
            matchId,
            human.user_id,
            opponent.user_id,
            repeatedPairCount,
          )
        : await readRiskDecision(tx, matchId, human.user_id);
      const proposedCoins = COIN_REWARDS[result];
      let reason = 'eligible';
      if (!config.FOOTBALL_GRID_COINS_ENABLED) reason = 'coins_disabled';
      else if (row.origin !== 'random') reason = 'friend_match_no_coins';
      else if (isForfeitReason(row.completion_reason)) reason = 'forfeit_no_coins';
      else if (opponentType === 'human' && repeatedPairCount > HUMAN_PAIR_DAILY_LIMIT) reason = 'repeated_pair_cap';
      else if (opponentType === 'bot' && budget.botMatches >= BOT_MATCH_DAILY_LIMIT) reason = 'bot_match_cap';
      else if (budget.coins + proposedCoins > COIN_DAILY_CAP) reason = 'daily_coin_cap';
      else if (result === 'loss' && !(human.claim_count >= 1 || (human.answer_turn_count >= 2 && durationMs >= 45_000))) reason = 'insufficient_participation';
      else if (risk?.decision === 'ineligible') reason = `risk_ineligible:${risk.reason}`;
      else if (risk?.decision === 'held') reason = `risk_hold:${risk.reason}`;
      const decision = reason.startsWith('risk_hold:')
        ? 'held'
        : reason === 'eligible'
          ? 'eligible'
          : 'ineligible';
      const eventAmount = decision === 'eligible' || decision === 'held' ? proposedCoins : 0;
      const coins = decision === 'eligible' ? proposedCoins : 0;
      await tx.unsafe(
        `INSERT INTO football_grid_reward_eligibility (
           match_id, user_id, evaluator_version, opponent_type, origin,
           participation, repeated_pair_count, rolling_coin_total,
           rolling_bot_matches, risk_decision, risk_signals, decision, reason
         ) VALUES ($1,$2,1,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11,$12)
         ON CONFLICT (match_id, user_id, evaluator_version) DO NOTHING`,
        [
          matchId, human.user_id, opponentType, row.origin,
          sql.json({ claimCount: human.claim_count, answerTurnCount: human.answer_turn_count, durationMs }),
          repeatedPairCount, budget.coins, budget.botMatches,
          risk?.decision ?? 'clear', sql.json((risk?.signals ?? {}) as Json), decision, reason,
        ],
      );
      if (eventAmount > 0) {
        const inserted = await tx.unsafe<Array<{ amount: number }>>(
          `INSERT INTO football_grid_coin_events (
             match_id, user_id, amount, status, eligibility_reason, credited_at
           ) VALUES ($1,$2,$3,$4,$5,CASE WHEN $4 = 'committed' THEN now() ELSE null END)
           ON CONFLICT (match_id, user_id, reward_type) DO NOTHING
           RETURNING amount`,
          [matchId, human.user_id, eventAmount, decision === 'held' ? 'held' : 'committed', reason],
        );
        if (inserted[0] && decision === 'eligible') {
          await tx.unsafe(`UPDATE users SET coins = coins + $2, updated_at = now() WHERE id = $1`, [human.user_id, coins]);
        }
      }
      results.set(human.user_id, { xp, coins, eligibilityReason: reason });
      appMetrics.footballGridRewardEligibility.add(1, {
        reason,
        origin: row.origin,
        opponent_type: opponentType,
      });
    }
  }
  await tx.unsafe(
    `UPDATE football_grid_settlement_outbox
        SET status = 'completed', completed_at = now(), next_retry_at = null
      WHERE id = $1`,
    [row.outbox_id],
  );
  await tx.unsafe(
    `UPDATE matches
        SET state_payload = COALESCE(state_payload, '{}'::jsonb)
              || '{"footballGridRewardsSettled":true}'::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [matchId],
  );
  return results;
}

async function readSettledRewardsInTx(
  tx: TransactionSql,
  matchId: string,
): Promise<Map<string, FootballGridRewardResult>> {
  const rows = await tx.unsafe<Array<{
    user_id: string;
    amount: number | null;
    coin_status: string | null;
    xp_delta: number | null;
    reason: string;
  }>>(
    `SELECT e.user_id, c.amount, c.status AS coin_status, x.xp_delta, e.reason
       FROM football_grid_reward_eligibility e
       LEFT JOIN football_grid_coin_events c ON c.match_id = e.match_id AND c.user_id = e.user_id
          AND c.reversal_of IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM football_grid_coin_events reversal WHERE reversal.reversal_of = c.id
          )
       LEFT JOIN user_xp_events x ON x.user_id = e.user_id
          AND x.source_type = 'match_result' AND x.source_key = e.match_id::text
      WHERE e.match_id = $1 AND e.evaluator_version = 1`,
    [matchId],
  );
  const result = new Map<string, FootballGridRewardResult>();
  for (const row of rows) {
    result.set(row.user_id, {
      xp: row.xp_delta ?? 0,
      coins: row.coin_status === 'committed' ? row.amount ?? 0 : 0,
      eligibilityReason: row.reason,
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
  } finally {
    workerRunning = false;
  }
}

export const footballGridSettlementService = {
  async settleMatch(matchId: string): Promise<Map<string, FootballGridRewardResult>> {
    try {
      const result = await sql.begin((tx) => settleInTx(tx, matchId)) as Map<string, FootballGridRewardResult>;
      await reservationService.releaseIfSettled(matchId, 'completion');
      appMetrics.footballGridSettlements.add(1, { outcome: 'completed' });
      return result;
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
