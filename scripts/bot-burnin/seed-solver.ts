import type { BurnInBot } from './types.js';
import { seedRosterBots } from './s2-distribution.js';

export interface SolveSeedsResult {
  /** Pre-compensated starting RP per bot — feed to buildSchedule + the Stage-A write. */
  seedByUserId: Map<string, number>;
  /** The S2-shaped ladder the FINAL (post-Stage-B) RP is solved to land on. */
  targetByUserId: Map<string, number>;
  iterations: number;
  /** Largest |finalRp - targetRp| across the roster at the returned seeds. */
  maxResidual: number;
  converged: boolean;
}

export const SEED_SOLVER_MAX_ITERATIONS = 5;
/**
 * Stage B settles in ±50/±25 steps, so a bot's reachable final RP is a coarse
 * lattice — a few-RP tolerance is unreachable by construction. One lattice step
 * (the largest single-match swing) is the meaningful convergence bar; the ladder
 * SHAPE is what the report and tests actually assert.
 */
export const SEED_SOLVER_TOLERANCE_RP = 125;

/**
 * Back-solve the Stage-A seeds so the FINAL post-Stage-B LADDER matches the S2
 * target shape.
 *
 * Players only ever see the FINAL ladder, but Stage B is net-positive RP (a win
 * pays +50 while a loss costs only -25), so seeding the target directly inflates
 * the roster ~+174 off-shape.
 *
 * The correction is applied BY RANK, not per bot. Seeds drive RP-neighbour
 * pairing, so nudging one bot's seed reshuffles who it plays and flips match
 * outcomes: the seed→final map is discontinuous and non-monotonic (measured: +10
 * seed moved a bot +100, +30 moved it −70). Per-identity fixed-point iteration
 * therefore cannot converge — it plateaus around a ±120 RP mean residual. Since
 * the goal is distributional, each iteration instead sorts bots by final RP and
 * aims rank r at the target ladder's rank r, which converges the tier histogram
 * within two iterations and is stable thereafter. Residual RP per bot stays near
 * the ±50/±25 lattice spacing, which is the floor for a 12-match window.
 */
export function solveSeeds(opts: {
  bots: readonly BurnInBot[];
  ceilingRp: number;
  seed: number;
  /** Plans Stage B from the given starting RP and returns each bot's final RP. */
  planFinalRp: (seedByUserId: ReadonlyMap<string, number>) => Map<string, number>;
  maxIterations?: number;
  toleranceRp?: number;
}): SolveSeedsResult {
  const { bots, ceilingRp, seed, planFinalRp } = opts;
  const maxIterations = opts.maxIterations ?? SEED_SOLVER_MAX_ITERATIONS;
  const toleranceRp = opts.toleranceRp ?? SEED_SOLVER_TOLERANCE_RP;

  const targetByUserId = new Map(
    seedRosterBots(bots, seed, ceilingRp).map((bot) => [bot.userId, bot.seededRp]),
  );

  const clamp = (rp: number): number => Math.max(0, Math.min(Math.floor(ceilingRp), Math.round(rp)));

  // The target LADDER, ascending — rank r of the final ladder is aimed here.
  const targetLadder = [...targetByUserId.values()].sort((a, b) => a - b);

  /**
   * Rank-match one pass: sort by final RP (ties broken by userId so the ordering
   * is total and seed-independent), then shift each bot's seed by the gap between
   * its final RP and the target ladder value at its rank.
   */
  const step = (
    seeds: ReadonlyMap<string, number>,
  ): { next: Map<string, number>; maxResidual: number } => {
    const finalByUserId = planFinalRp(seeds);
    const ranked = [...targetByUserId.keys()].sort((a, b) => {
      const rpA = finalByUserId.get(a) ?? 0;
      const rpB = finalByUserId.get(b) ?? 0;
      return rpA !== rpB ? rpA - rpB : a.localeCompare(b);
    });

    const next = new Map<string, number>();
    let maxResidual = 0;
    ranked.forEach((userId, rank) => {
      const want = targetLadder[rank];
      const residual = want - (finalByUserId.get(userId) ?? want);
      if (Math.abs(residual) > maxResidual) maxResidual = Math.abs(residual);
      next.set(userId, clamp((seeds.get(userId) ?? want) + residual));
    });
    return { next, maxResidual };
  };

  let seedByUserId = new Map(targetByUserId);
  let maxResidual = Number.POSITIVE_INFINITY;
  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;
    const { next, maxResidual: residual } = step(seedByUserId);
    maxResidual = residual;
    if (residual <= toleranceRp) {
      return { seedByUserId, targetByUserId, iterations, maxResidual, converged: true };
    }
    seedByUserId = next;
  }

  // Report the residual of the seeds actually returned, not of the prior pass.
  maxResidual = step(seedByUserId).maxResidual;
  return {
    seedByUserId,
    targetByUserId,
    iterations,
    maxResidual,
    converged: maxResidual <= toleranceRp,
  };
}
