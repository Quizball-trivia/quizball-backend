import { sql, type TransactionSql } from '../../db/index.js';
import type {
  FootballGridBotGovernorState,
} from './football-grid-bot-governor.js';
import { parseFootballGridBotStrengthAdjustment } from './football-grid-bot-governor.js';

interface GovernorStateRow {
  strength_adjustment: string | number;
  score_ema: string | number | null;
  observation_count: number;
  observations_at_adjustment: number;
  adjustment_updated_at: string | null;
}

export interface FootballGridCompletedBotMatch {
  matchId: string;
  winnerUserId: string | null;
  completionReason: 'line' | 'board_full' | 'turn_limit';
  botUserId: string;
  humanUserId: string;
  modelVersion: number;
  configVersion: number;
  botTier: string;
  pinnedStrengthAdjustment: string | number | null;
}

interface CompletedBotMatchRow {
  match_id: string;
  winner_user_id: string | null;
  completion_reason: 'line' | 'board_full' | 'turn_limit';
  bot_user_id: string;
  human_user_id: string;
  bot_model_version: number;
  bot_config_version: number;
  bot_tier: string;
  bot_strength_adjustment: string | number | null;
}

function numberOrThrow(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid Football Grid governor ${field}`);
  return parsed;
}

function mapState(row: GovernorStateRow): FootballGridBotGovernorState {
  const adjustmentUpdatedAt = row.adjustment_updated_at === null
    ? null
    : new Date(row.adjustment_updated_at);
  if (adjustmentUpdatedAt && !Number.isFinite(adjustmentUpdatedAt.getTime())) {
    throw new Error('Invalid Football Grid governor adjustment timestamp');
  }
  return {
    strengthAdjustment: parseFootballGridBotStrengthAdjustment(row.strength_adjustment, { required: true }),
    scoreEma: row.score_ema === null ? null : numberOrThrow(row.score_ema, 'score EMA'),
    observationCount: row.observation_count,
    observationsAtAdjustment: row.observations_at_adjustment,
    adjustmentUpdatedAt,
  };
}

export const footballGridBotGovernorRepo = {
  async runInTransaction<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return sql.begin(fn) as Promise<T>;
  },

  async loadCompletedBotMatchInTx(
    tx: TransactionSql,
    matchId: string,
  ): Promise<FootballGridCompletedBotMatch | null> {
    const rows = await tx.unsafe<CompletedBotMatchRow[]>(
      `SELECT gm.match_id, m.winner_user_id, gm.completion_reason,
              gm.bot_user_id, human.user_id AS human_user_id,
              gm.bot_model_version, gm.bot_config_version, gm.bot_tier,
              gm.bot_strength_adjustment
         FROM football_grid_matches gm
         JOIN matches m ON m.id = gm.match_id
         JOIN football_grid_settlement_outbox settlement
           ON settlement.match_id = gm.match_id AND settlement.status = 'completed'
         JOIN football_grid_participants bot
           ON bot.match_id = gm.match_id
          AND bot.user_id = gm.bot_user_id
          AND bot.is_bot = true
         JOIN football_grid_participants human
           ON human.match_id = gm.match_id AND human.is_bot = false
        WHERE gm.match_id = $1
          AND m.status = 'completed'
          AND gm.bot_model_version = 2
          AND gm.bot_config_version = 1
          AND gm.completion_reason IN ('line', 'board_full', 'turn_limit')
          AND (SELECT count(*) FROM football_grid_participants participants
                WHERE participants.match_id = gm.match_id) = 2
        LIMIT 1`,
      [matchId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      matchId: row.match_id,
      winnerUserId: row.winner_user_id,
      completionReason: row.completion_reason,
      botUserId: row.bot_user_id,
      humanUserId: row.human_user_id,
      modelVersion: row.bot_model_version,
      configVersion: row.bot_config_version,
      botTier: row.bot_tier,
      pinnedStrengthAdjustment: row.bot_strength_adjustment,
    };
  },

  async listUnobservedCompletedMatchIds(limit: number): Promise<string[]> {
    const rows = await sql<Array<{ match_id: string }>>`
      SELECT settlement.match_id
        FROM football_grid_settlement_outbox settlement
        JOIN football_grid_matches gm ON gm.match_id = settlement.match_id
        JOIN matches m ON m.id = settlement.match_id
       WHERE settlement.status = 'completed'
         AND m.status = 'completed'
         AND gm.bot_model_version = 2
         AND gm.bot_config_version = 1
         AND gm.bot_strength_adjustment IS NOT NULL
         AND gm.completion_reason IN ('line', 'board_full', 'turn_limit')
         AND EXISTS (
           SELECT 1 FROM football_grid_participants bot
            WHERE bot.match_id = gm.match_id
              AND bot.user_id = gm.bot_user_id
              AND bot.is_bot = true
         )
         AND EXISTS (
           SELECT 1 FROM football_grid_participants human
            WHERE human.match_id = gm.match_id AND human.is_bot = false
         )
         AND (SELECT count(*) FROM football_grid_participants participants
               WHERE participants.match_id = gm.match_id) = 2
         AND NOT EXISTS (
           SELECT 1 FROM football_grid_bot_governor_observations observation
            WHERE observation.match_id = settlement.match_id
         )
       ORDER BY settlement.completed_at, settlement.match_id
       LIMIT ${limit}
    `;
    return rows.map((row) => row.match_id);
  },

  async ensureAndLockStateInTx(
    tx: TransactionSql,
    input: { modelVersion: number; configVersion: number; botTier: string },
  ): Promise<FootballGridBotGovernorState> {
    await tx.unsafe(
      `INSERT INTO football_grid_bot_governor_state (
         bot_model_version, bot_config_version, bot_tier
       ) VALUES ($1,$2,$3)
       ON CONFLICT (bot_model_version, bot_config_version, bot_tier) DO NOTHING`,
      [input.modelVersion, input.configVersion, input.botTier],
    );
    const rows = await tx.unsafe<GovernorStateRow[]>(
      `SELECT strength_adjustment, score_ema, observation_count,
              observations_at_adjustment, adjustment_updated_at
         FROM football_grid_bot_governor_state
        WHERE bot_model_version = $1 AND bot_config_version = $2 AND bot_tier = $3
        FOR NO KEY UPDATE`,
      [input.modelVersion, input.configVersion, input.botTier],
    );
    if (!rows[0]) throw new Error('Football Grid governor state could not be locked');
    return mapState(rows[0]);
  },

  async insertObservationInTx(
    tx: TransactionSql,
    input: {
      matchId: string;
      modelVersion: number;
      configVersion: number;
      botTier: string;
      pinnedStrengthAdjustment: number;
      outcomeScore: 0 | 0.5 | 1;
      completionReason: 'line' | 'board_full' | 'turn_limit';
    },
  ): Promise<boolean> {
    const inserted = await tx.unsafe<Array<{ match_id: string }>>(
      `INSERT INTO football_grid_bot_governor_observations (
         match_id, bot_model_version, bot_config_version, bot_tier,
         pinned_strength_adjustment, outcome_score, completion_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (match_id) DO NOTHING
       RETURNING match_id`,
      [
        input.matchId,
        input.modelVersion,
        input.configVersion,
        input.botTier,
        input.pinnedStrengthAdjustment,
        input.outcomeScore,
        input.completionReason,
      ],
    );
    return inserted.length === 1;
  },

  async updateStateInTx(
    tx: TransactionSql,
    input: {
      modelVersion: number;
      configVersion: number;
      botTier: string;
      state: FootballGridBotGovernorState;
    },
  ): Promise<void> {
    await tx.unsafe(
      `UPDATE football_grid_bot_governor_state
          SET strength_adjustment = $4, score_ema = $5,
              observation_count = $6, observations_at_adjustment = $7,
              adjustment_updated_at = $8, updated_at = now()
        WHERE bot_model_version = $1 AND bot_config_version = $2 AND bot_tier = $3`,
      [
        input.modelVersion,
        input.configVersion,
        input.botTier,
        input.state.strengthAdjustment,
        input.state.scoreEma,
        input.state.observationCount,
        input.state.observationsAtAdjustment,
        input.state.adjustmentUpdatedAt?.toISOString() ?? null,
      ],
    );
  },

  async insertActionAuditInTx(
    tx: TransactionSql,
    input: {
      matchId: string;
      turnNumber: number;
      botUserId: string;
      cellIndex: number;
      outcome: 'correct' | 'wrong' | 'pass';
      modelVersion: number;
      configVersion: number;
      botTier: string;
      baseAccuracy: number;
      scarcityMultiplier: number;
      effectiveAccuracy: number;
      tacticalOptimality: number;
      passOnMiss: number;
      candidateCount: number;
      recognizablePoolSize: number;
      pinnedStrengthAdjustment: number;
    },
  ): Promise<void> {
    await tx.unsafe(
      `INSERT INTO football_grid_bot_action_audits (
         match_id, turn_number, bot_user_id, cell_index, outcome,
         bot_model_version, bot_config_version, bot_tier,
         base_accuracy, scarcity_multiplier, effective_accuracy,
         tactical_optimality, pass_on_miss, candidate_count,
         recognizable_pool_size, pinned_strength_adjustment
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (match_id, turn_number) DO NOTHING`,
      [
        input.matchId,
        input.turnNumber,
        input.botUserId,
        input.cellIndex,
        input.outcome,
        input.modelVersion,
        input.configVersion,
        input.botTier,
        input.baseAccuracy,
        input.scarcityMultiplier,
        input.effectiveAccuracy,
        input.tacticalOptimality,
        input.passOnMiss,
        input.candidateCount,
        input.recognizablePoolSize,
        input.pinnedStrengthAdjustment,
      ],
    );
  },
};
