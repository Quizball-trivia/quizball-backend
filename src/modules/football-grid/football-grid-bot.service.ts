import { config } from '../../core/config.js';
import { appMetrics } from '../../core/metrics.js';
import { applyResolvedAnswer, FOOTBALL_GRID_WIN_LINES, passTurn,
  countWinnableLines,
} from './football-grid.engine.js';
import { parseFootballGridBotStrengthAdjustment } from './football-grid-bot-governor.js';
import { footballGridBotGovernorService } from './football-grid-bot-governor.service.js';
import { footballGridRepo } from './football-grid.repo.js';
import type { FootballGridState } from './football-grid.types.js';

const TIER_ORDER = [
  'Academy', 'Youth Prospect', 'Reserve', 'Bench', 'Rotation', 'Starting11',
  'Key Player', 'Captain', 'World-Class', 'Legend', 'GOAT',
] as const;

function seededUnit(seed: number, turnNumber: number, salt: number): number {
  let value = (seed ^ Math.imul(turnNumber + 1, 0x9e3779b1) ^ salt) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0x1_0000_0000;
}

function tierIndex(tier: string): number {
  const index = TIER_ORDER.indexOf(tier as typeof TIER_ORDER[number]);
  return index < 0 ? 2 : index;
}

export interface FootballGridBotTierPolicy {
  accuracy: number;
  tacticalOptimality: number;
  passOnMiss: number;
  minDelayMs: number;
  maxDelayMs: number;
}

export function footballGridBotTierPolicy(tier: string): FootballGridBotTierPolicy {
  const skill = tierIndex(tier) / (TIER_ORDER.length - 1);
  return {
    accuracy: Math.min(0.94, 0.46 + tierIndex(tier) * 0.048),
    tacticalOptimality: 0.48 + skill * 0.50,
    passOnMiss: 0.34 - skill * 0.25,
    minDelayMs: Math.round(3_500 - skill * 1_000),
    maxDelayMs: Math.round(14_000 - skill * 8_500),
  };
}

export function footballGridBotTierPolicyV2(tier: string): FootballGridBotTierPolicy {
  const index = tierIndex(tier);
  const skill = index / (TIER_ORDER.length - 1);
  return {
    accuracy: Number((0.42 + index * 0.04).toFixed(2)),
    tacticalOptimality: Number((0.45 + index * 0.04).toFixed(2)),
    passOnMiss: Number((0.38 - index * 0.02).toFixed(2)),
    minDelayMs: Math.round(7_000 - skill * 2_500),
    maxDelayMs: Math.round(16_000 - skill * 5_000),
  };
}

export function footballGridBotTierPolicyForVersion(
  modelVersion: number,
  configVersion: number,
  tier: string,
): FootballGridBotTierPolicy {
  // Version 1 is intentionally an immutable dispatch branch. New deployments
  // must add a new branch rather than changing the coefficients used by live
  // or replayed v1 matches.
  if (modelVersion === 1 && configVersion === 1) return footballGridBotTierPolicy(tier);
  if (modelVersion === 2 && configVersion === 1) return footballGridBotTierPolicyV2(tier);
  throw new Error(`Unsupported Football Grid bot policy ${modelVersion}/${configVersion}`);
}

export function footballGridBotScarcityMultiplier(
  modelVersion: number,
  configVersion: number,
  chosenCellUnusedAnswerCount: number,
): number {
  if (modelVersion === 1 && configVersion === 1) return 1;
  if (modelVersion !== 2 || configVersion !== 1) {
    throw new Error(`Unsupported Football Grid bot policy ${modelVersion}/${configVersion}`);
  }
  if (chosenCellUnusedAnswerCount <= 9) return 0.85;
  if (chosenCellUnusedAnswerCount <= 14) return 0.92;
  return 1;
}

export type FootballGridBotDifficulty = 'easy' | 'adaptive';

// Ceilings for FOOTBALL_GRID_BOT_DIFFICULTY=easy. The tier model still picks
// the bot and its delays; only knowledge and tactics are capped so a casual
// player wins more often than not.
export const FOOTBALL_GRID_EASY_BOT_CAPS = Object.freeze({
  accuracy: 0.38,
  tacticalOptimality: 0.45,
  passOnMiss: 0.5,
});

export function footballGridBotDifficulty(): FootballGridBotDifficulty {
  return config.FOOTBALL_GRID_BOT_DIFFICULTY;
}

export function applyFootballGridBotDifficulty(
  policy: FootballGridBotTierPolicy,
  difficulty: FootballGridBotDifficulty,
): FootballGridBotTierPolicy {
  if (difficulty !== 'easy') return policy;
  return {
    ...policy,
    accuracy: Math.min(policy.accuracy, FOOTBALL_GRID_EASY_BOT_CAPS.accuracy),
    tacticalOptimality: Math.min(policy.tacticalOptimality, FOOTBALL_GRID_EASY_BOT_CAPS.tacticalOptimality),
    passOnMiss: Math.max(policy.passOnMiss, FOOTBALL_GRID_EASY_BOT_CAPS.passOnMiss),
  };
}

export function footballGridBotEffectiveAccuracy(input: {
  modelVersion: number;
  configVersion: number;
  tier: string;
  strengthAdjustment: number;
  chosenCellUnusedAnswerCount: number;
  difficulty?: FootballGridBotDifficulty;
}): { baseAccuracy: number; scarcityMultiplier: number; effectiveAccuracy: number } {
  const policy = footballGridBotTierPolicyForVersion(
    input.modelVersion,
    input.configVersion,
    input.tier,
  );
  const cap = input.difficulty === 'easy' ? FOOTBALL_GRID_EASY_BOT_CAPS.accuracy : 1;
  if (input.modelVersion === 1 && input.configVersion === 1) {
    const effectiveAccuracy = Math.min(cap, policy.accuracy);
    return { baseAccuracy: policy.accuracy, scarcityMultiplier: 1, effectiveAccuracy };
  }
  const strengthAdjustment = parseFootballGridBotStrengthAdjustment(
    input.strengthAdjustment,
    { required: true },
  );
  const scarcityMultiplier = footballGridBotScarcityMultiplier(
    input.modelVersion,
    input.configVersion,
    input.chosenCellUnusedAnswerCount,
  );
  if (input.chosenCellUnusedAnswerCount <= 0) {
    return { baseAccuracy: policy.accuracy, scarcityMultiplier, effectiveAccuracy: 0 };
  }
  // The governor trims the tier baseline first; cell scarcity then makes the
  // selected intersection no easier. Final clamp is the invariant that no
  // modifier may ever strengthen a bot above its tier's safe v2 baseline.
  const effectiveAccuracy = Math.min(
    cap,
    policy.accuracy,
    Math.max(0, policy.accuracy + strengthAdjustment) * scarcityMultiplier,
  );
  return { baseAccuracy: policy.accuracy, scarcityMultiplier, effectiveAccuracy };
}

export function footballGridBotRecognizableCandidates(
  modelVersion: number,
  configVersion: number,
  orderedCandidateIds: string[],
): string[] {
  if (modelVersion === 1 && configVersion === 1) return orderedCandidateIds;
  if (modelVersion === 2 && configVersion === 1) return orderedCandidateIds.slice(0, 5);
  throw new Error(`Unsupported Football Grid bot policy ${modelVersion}/${configVersion}`);
}

export function footballGridBotAccuracy(tier: string): number {
  return footballGridBotTierPolicy(tier).accuracy;
}

export function footballGridBotDelayMs(tier: string, seed: number, turnNumber: number): number {
  const policy = footballGridBotTierPolicy(tier);
  return Math.round(
    policy.minDelayMs
      + seededUnit(seed, turnNumber, 0x51f15e) * Math.max(500, policy.maxDelayMs - policy.minDelayMs),
  );
}

export function footballGridBotActionIsOnTime(nowMs: number, deadlineAt: string | null): boolean {
  const deadlineMs = Date.parse(deadlineAt ?? '');
  return Number.isFinite(nowMs) && Number.isFinite(deadlineMs) && nowMs <= deadlineMs;
}

function scarcityBucket(candidateCount: number): 'scarce_0_9' | 'limited_10_14' | 'broad_15_plus' {
  if (candidateCount <= 9) return 'scarce_0_9';
  if (candidateCount <= 14) return 'limited_10_14';
  return 'broad_15_plus';
}

function completingCell(state: FootballGridState, userId: string): number | null {
  const occupied = new Map(state.claims.map((claim) => [claim.cellIndex, claim.claimantUserId]));
  for (const line of FOOTBALL_GRID_WIN_LINES) {
    const mine = line.filter((cell) => occupied.get(cell) === userId);
    const open = line.filter((cell) => !occupied.has(cell));
    if (mine.length === 2 && open.length === 1) return open[0];
  }
  return null;
}

export function chooseFootballGridBotCell(
  state: FootballGridState,
  botUserId: string,
  seed: number,
  tier = 'Reserve',
  pinnedPolicy?: FootballGridBotTierPolicy,
): number {
  const open = [4, 0, 2, 6, 8, 1, 3, 5, 7].filter(
    (cell) => !state.claims.some((claim) => claim.cellIndex === cell),
  );
  if (seededUnit(seed, state.turnNumber, 0x44aa91) <= (pinnedPolicy ?? footballGridBotTierPolicy(tier)).tacticalOptimality) {
    const win = completingCell(state, botUserId);
    if (win !== null) return win;
    const opponent = state.players.find((player) => player.userId !== botUserId)!;
    const block = completingCell(state, opponent.userId);
    if (block !== null) return block;
    return open[0] ?? 0;
  }
  return open[Math.floor(seededUnit(seed, state.turnNumber, 0x72d5c3) * open.length)] ?? 0;
}

/**
 * Draw policy: a bot takes a draw when it cannot win, or when the human is
 * ahead on open lines; with equal chances it settles once the board is late
 * (easy bots settle earlier). It never accepts while it is the only side that
 * can still win.
 */
export function footballGridBotShouldAcceptDraw(
  state: FootballGridState,
  botUserId: string,
  difficulty: FootballGridBotDifficulty,
): boolean {
  const opponent = state.players.find((player) => player.userId !== botUserId);
  const botLines = countWinnableLines(state.claims, botUserId);
  if (botLines === 0) return true;
  const opponentLines = opponent ? countWinnableLines(state.claims, opponent.userId) : 0;
  if (opponentLines === 0) return false;
  if (opponentLines > botLines) return true;
  if (opponentLines < botLines) return false;
  const lateBoardClaims = difficulty === 'easy' ? 4 : 6;
  return state.claims.length >= lateBoardClaims;
}

export const footballGridBotService = {
  /** A bot takes a draw only once it has no winnable line left; otherwise it plays on. */
  shouldAcceptDraw(
    state: FootballGridState,
    botUserId: string,
    difficulty: FootballGridBotDifficulty = footballGridBotDifficulty(),
  ): boolean {
    return footballGridBotShouldAcceptDraw(state, botUserId, difficulty);
  },

  async getSchedule(matchId: string, state: FootballGridState): Promise<{
    delayMs: number;
    expectedStateVersion: number;
    turnNumber: number;
  } | null> {
    if (state.phase !== 'turn' || !state.currentPlayerUserId) return null;
    const actor = state.players.find((player) => player.userId === state.currentPlayerUserId);
    if (!actor?.isBot) return null;
    const runtime = await footballGridRepo.getBotRuntime(matchId);
    if (!runtime || runtime.botUserId !== actor.userId) return null;
    const policy = footballGridBotTierPolicyForVersion(runtime.modelVersion, runtime.configVersion, runtime.botTier);
    return {
      delayMs: Math.round(
        policy.minDelayMs
          + seededUnit(runtime.rngSeed, state.turnNumber, 0x51f15e)
            * Math.max(500, policy.maxDelayMs - policy.minDelayMs),
      ),
      expectedStateVersion: state.stateVersion,
      turnNumber: state.turnNumber,
    };
  },

  async performTurn(input: {
    matchId: string;
    expectedStateVersion: number;
    turnNumber: number;
  }): Promise<{
    state: FootballGridState;
    changed: boolean;
    actorUserId: string | null;
    cellIndex: number | null;
    outcome: 'correct' | 'wrong' | 'pass' | null;
    resolvedPlayerId: string | null;
  }> {
    const runtime = await footballGridRepo.getBotRuntime(input.matchId);
    if (!runtime) throw new Error('Football Grid bot runtime is missing');
    const execution = await footballGridRepo.runInTransaction(async (tx) => {
      const previous = await footballGridRepo.loadStateForUpdate(tx, input.matchId);
      if (!previous) throw new Error('Football Grid match not found');
      if (
        previous.phase !== 'turn'
        || previous.currentPlayerUserId !== runtime.botUserId
        || previous.stateVersion !== input.expectedStateVersion
        || previous.turnNumber !== input.turnNumber
      ) {
        return {
          result: {
            state: previous,
            changed: false,
            actorUserId: null,
            cellIndex: null,
            outcome: null,
            resolvedPlayerId: null,
          },
          telemetry: null,
        };
      }
      const nowMs = await footballGridRepo.databaseNowMs(tx);
      // A delayed bot callback is never allowed to steal the match-row lock
      // after the advertised turn cutoff. The phase-deadline reconciler owns
      // timeout advancement in that case.
      if (!footballGridBotActionIsOnTime(
        nowMs,
        previous.turnDeadlineAt ?? previous.phaseDeadlineAt,
      )) {
        return {
          result: {
            state: previous,
            changed: false,
            actorUserId: null,
            cellIndex: null,
            outcome: null,
            resolvedPlayerId: null,
          },
          telemetry: null,
        };
      }
      const difficulty = footballGridBotDifficulty();
      const policy = applyFootballGridBotDifficulty(
        footballGridBotTierPolicyForVersion(runtime.modelVersion, runtime.configVersion, runtime.botTier),
        difficulty,
      );
      const cellIndex = chooseFootballGridBotCell(
        previous,
        runtime.botUserId,
        runtime.rngSeed,
        runtime.botTier,
        policy,
      );
      const answers = await footballGridRepo.getUnusedAnswersForCellsInTx(tx, input.matchId, [cellIndex]);
      const candidates = answers.get(cellIndex) ?? [];
      const recognizableCandidates = footballGridBotRecognizableCandidates(
        runtime.modelVersion,
        runtime.configVersion,
        candidates,
      );
      const accuracy = footballGridBotEffectiveAccuracy({
        modelVersion: runtime.modelVersion,
        configVersion: runtime.configVersion,
        tier: runtime.botTier,
        strengthAdjustment: runtime.strengthAdjustment,
        chosenCellUnusedAnswerCount: candidates.length,
        difficulty,
      });
      const accurate = recognizableCandidates.length > 0
        && seededUnit(runtime.rngSeed, previous.turnNumber, 0x19660d) <= accuracy.effectiveAccuracy;
      const footballPlayerId = accurate
        ? recognizableCandidates[Math.floor(
            seededUnit(runtime.rngSeed, previous.turnNumber, 0x3c6ef3) * recognizableCandidates.length,
          )]
        : null;
      const passes = !accurate
        && seededUnit(runtime.rngSeed, previous.turnNumber, 0xa53c9e) <= policy.passOnMiss;
      let next = passes
        ? passTurn(previous, runtime.botUserId, previous.stateVersion, nowMs)
        : applyResolvedAnswer(previous, {
            userId: runtime.botUserId,
            expectedStateVersion: previous.stateVersion,
            cellIndex,
            outcome: accurate ? 'correct' : 'wrong',
            footballPlayerId,
            nowMs,
          });
      await footballGridRepo.persistStateInTx(tx, previous, next, {
        eventType: accurate ? 'bot_cell_claimed' : passes ? 'bot_passed' : 'bot_wrong_answer',
        eventPayload: {
          actorUserId: runtime.botUserId,
          cellIndex,
          modelVersion: runtime.modelVersion,
          configVersion: runtime.configVersion,
        },
        ...(accurate && footballPlayerId ? {
          acceptedClaim: {
            cellIndex,
            footballPlayerId,
            claimantUserId: runtime.botUserId,
            turnNumber: previous.turnNumber,
            aliasId: null,
            locale: 'en' as const,
          },
        } : {}),
      });
      const outcome: 'correct' | 'wrong' | 'pass' = accurate ? 'correct' : passes ? 'pass' : 'wrong';
      // Same as the human path: a claim broadcast must include the player's
      // name and photo, which only the persisted rows carry.
      if (accurate) next = (await footballGridRepo.loadStateForUpdate(tx, input.matchId)) ?? next;
      if (runtime.modelVersion === 2 && runtime.configVersion === 1) {
        await footballGridBotGovernorService.recordActionInTx(tx, {
          matchId: input.matchId,
          turnNumber: previous.turnNumber,
          botUserId: runtime.botUserId,
          cellIndex,
          outcome,
          modelVersion: runtime.modelVersion,
          configVersion: runtime.configVersion,
          botTier: runtime.botTier,
          baseAccuracy: accuracy.baseAccuracy,
          scarcityMultiplier: accuracy.scarcityMultiplier,
          effectiveAccuracy: accuracy.effectiveAccuracy,
          tacticalOptimality: policy.tacticalOptimality,
          passOnMiss: policy.passOnMiss,
          candidateCount: candidates.length,
          recognizablePoolSize: recognizableCandidates.length,
          pinnedStrengthAdjustment: runtime.strengthAdjustment,
        });
      }
      return {
        result: {
          state: next,
          changed: true,
          actorUserId: runtime.botUserId,
          cellIndex,
          outcome,
          resolvedPlayerId: accurate ? footballPlayerId : null,
        },
        telemetry: {
          tier: runtime.botTier,
          modelVersion: runtime.modelVersion,
          outcome,
          candidateCount: candidates.length,
        },
      };
    });
    if (execution.telemetry) {
      appMetrics.footballGridBotActions.add(1, {
        tier: execution.telemetry.tier,
        model_version: String(execution.telemetry.modelVersion),
        outcome: execution.telemetry.outcome,
        scarcity_bucket: scarcityBucket(execution.telemetry.candidateCount),
      });
    }
    return execution.result;
  },
};
