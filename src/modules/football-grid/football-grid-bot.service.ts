import { applyResolvedAnswer, FOOTBALL_GRID_WIN_LINES, passTurn } from './football-grid.engine.js';
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

export function footballGridBotTierPolicyForVersion(
  modelVersion: number,
  configVersion: number,
  tier: string,
): FootballGridBotTierPolicy {
  // Version 1 is intentionally an immutable dispatch branch. New deployments
  // must add a new branch rather than changing the coefficients used by live
  // or replayed v1 matches.
  if (modelVersion === 1 && configVersion === 1) return footballGridBotTierPolicy(tier);
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

export const footballGridBotService = {
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
    return footballGridRepo.runInTransaction(async (tx) => {
      const previous = await footballGridRepo.loadStateForUpdate(tx, input.matchId);
      if (!previous) throw new Error('Football Grid match not found');
      if (
        previous.phase !== 'turn'
        || previous.currentPlayerUserId !== runtime.botUserId
        || previous.stateVersion !== input.expectedStateVersion
        || previous.turnNumber !== input.turnNumber
      ) {
        return {
          state: previous,
          changed: false,
          actorUserId: null,
          cellIndex: null,
          outcome: null,
          resolvedPlayerId: null,
        };
      }
      const nowMs = await footballGridRepo.databaseNowMs(tx);
      const turnDeadlineMs = Date.parse(previous.turnDeadlineAt ?? previous.phaseDeadlineAt ?? '');
      // A delayed bot callback is never allowed to steal the match-row lock
      // after the advertised turn cutoff. The phase-deadline reconciler owns
      // timeout advancement in that case.
      if (Number.isFinite(turnDeadlineMs) && nowMs > turnDeadlineMs) {
        return {
          state: previous,
          changed: false,
          actorUserId: null,
          cellIndex: null,
          outcome: null,
          resolvedPlayerId: null,
        };
      }
      const policy = footballGridBotTierPolicyForVersion(runtime.modelVersion, runtime.configVersion, runtime.botTier);
      const cellIndex = chooseFootballGridBotCell(
        previous,
        runtime.botUserId,
        runtime.rngSeed,
        runtime.botTier,
        policy,
      );
      const answers = await footballGridRepo.getUnusedAnswersForCellsInTx(tx, input.matchId, [cellIndex]);
      const candidates = answers.get(cellIndex) ?? [];
      const accurate = candidates.length > 0
        && seededUnit(runtime.rngSeed, previous.turnNumber, 0x19660d) <= policy.accuracy;
      const footballPlayerId = accurate
        ? candidates[Math.floor(seededUnit(runtime.rngSeed, previous.turnNumber, 0x3c6ef3) * candidates.length)]
        : null;
      const passes = !accurate
        && seededUnit(runtime.rngSeed, previous.turnNumber, 0xa53c9e) <= policy.passOnMiss;
      const next = passes
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
      return {
        state: next,
        changed: true,
        actorUserId: runtime.botUserId,
        cellIndex,
        outcome: accurate ? 'correct' : passes ? 'pass' : 'wrong',
        resolvedPlayerId: accurate ? footballPlayerId : null,
      };
    });
  },
};
