import { config } from '../../core/config.js';
import type { TransactionSql } from '../../db/index.js';
import {
  clampFootballGridBotStrengthAdjustment,
  parseFootballGridBotStrengthAdjustment,
  stepFootballGridBotGovernor,
  type FootballGridBotGovernorDecision,
} from './football-grid-bot-governor.js';
import { footballGridBotGovernorRepo } from './football-grid-bot-governor.repo.js';

export const footballGridBotGovernorService = {
  async pinStrengthAdjustmentInTx(
    tx: TransactionSql,
    input: { modelVersion: number; configVersion: number; botTier: string },
  ): Promise<number> {
    const state = await footballGridBotGovernorRepo.ensureAndLockStateInTx(tx, input);
    if (!config.FOOTBALL_GRID_BOT_GOVERNOR_ENABLED) return 0;
    return clampFootballGridBotStrengthAdjustment(state.strengthAdjustment);
  },

  async observeSettlementInTx(
    tx: TransactionSql,
    input: {
      matchId: string;
      modelVersion: number;
      configVersion: number;
      botTier: string;
      pinnedStrengthAdjustment: number;
      outcomeScore: 0 | 0.5 | 1;
      completionReason: 'line' | 'board_full' | 'turn_limit';
      now: Date;
    },
  ): Promise<FootballGridBotGovernorDecision | null> {
    const inserted = await footballGridBotGovernorRepo.insertObservationInTx(tx, input);
    if (!inserted) return null;
    const state = await footballGridBotGovernorRepo.ensureAndLockStateInTx(tx, input);
    const decision = stepFootballGridBotGovernor(state, {
      outcomeScore: input.outcomeScore,
      now: input.now,
      enabled: config.FOOTBALL_GRID_BOT_GOVERNOR_ENABLED,
    });
    await footballGridBotGovernorRepo.updateStateInTx(tx, {
      ...input,
      state: decision.next,
    });
    return decision;
  },

  /**
   * Fold a completed match in an independent transaction. Reward settlement is
   * the durable source record and never waits on this safety/telemetry loop.
   * The observation primary key makes direct attempts and recovery scans safe
   * to race or replay.
   */
  async observeCompletedMatch(matchId: string): Promise<{
    decision: FootballGridBotGovernorDecision;
    botTier: string;
    modelVersion: number;
  } | null> {
    return footballGridBotGovernorRepo.runInTransaction(async (tx) => {
      const match = await footballGridBotGovernorRepo.loadCompletedBotMatchInTx(tx, matchId);
      if (!match) return null;
      const pinnedStrengthAdjustment = parseFootballGridBotStrengthAdjustment(
        match.pinnedStrengthAdjustment,
        { required: true },
      );
      const outcomeScore: 0 | 0.5 | 1 = match.winnerUserId === null
        ? 0.5
        : match.winnerUserId === match.botUserId
          ? 1
          : match.winnerUserId === match.humanUserId
            ? 0
            : (() => { throw new Error('Football Grid winner is not a match participant'); })();
      const nowRows = await tx.unsafe<Array<{ now: string }>>(`SELECT now()::text AS now`);
      const decision = await this.observeSettlementInTx(tx, {
        matchId: match.matchId,
        modelVersion: match.modelVersion,
        configVersion: match.configVersion,
        botTier: match.botTier,
        pinnedStrengthAdjustment,
        outcomeScore,
        completionReason: match.completionReason,
        now: new Date(nowRows[0].now),
      });
      return decision ? { decision, botTier: match.botTier, modelVersion: match.modelVersion } : null;
    });
  },

  async listUnobservedCompletedMatchIds(limit: number): Promise<string[]> {
    return footballGridBotGovernorRepo.listUnobservedCompletedMatchIds(limit);
  },

  recordActionInTx: footballGridBotGovernorRepo.insertActionAuditInTx,
};
