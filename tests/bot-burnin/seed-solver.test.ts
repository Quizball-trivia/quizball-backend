/**
 * Pure (no-DB) tests for the Stage-A seed solver.
 *
 * Stage B is net-positive RP, so seeding the S2 target directly inflates the
 * roster off-shape. The solver back-solves the seeds by RANK so the FINAL
 * (post-Stage-B) ladder — the one players see — lands on the target shape.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSchedule } from '../../scripts/bot-burnin/scheduler.js';
import { solveSeeds } from '../../scripts/bot-burnin/seed-solver.js';
import { parseBotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import { tierFromRp } from '../../src/modules/ranked/season-rp-formula.js';
import type { BurnInBot } from '../../scripts/bot-burnin/types.js';

const params = parseBotModelParams(
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures/params.json'), 'utf8')),
);

const SEASON_START = new Date('2026-07-21T00:00:00Z');
const RUN_DATE = new Date('2026-07-28T00:00:00Z');
const SEED = 20260721;
const CEILING_RP = 2565;

function makeBots(n: number): BurnInBot[] {
  const ranges = [[0.05, 0.25], [0.25, 0.45], [0.45, 0.6], [0.6, 0.75], [0.75, 0.9]] as const;
  return Array.from({ length: n }, (_, i) => {
    const fraction = (i + 0.5) / n;
    const skillBand = fraction < 0.2 ? 0 : fraction < 0.5 ? 1 : fraction < 0.8 ? 2 : fraction < 0.95 ? 3 : 4;
    const [lo, hi] = ranges[skillBand];
    return {
      userId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      nickname: `bot_${i}`,
      baseSkill: lo + ((i * 0.61803398875) % 1) * (hi - lo),
      dailyCap: 6,
      schedule: { activeHours: [], sessionMax: 4, intraSessionGapMin: 20 },
      status: 'active' as const,
      skillBand,
      rp: 450,
      placementPlayed: 0,
      placementWins: 0,
      placementStatus: 'unplaced' as const,
      currentWinStreak: 0,
    };
  });
}

function solveFor(bots: BurnInBot[]) {
  const plan = (seedOverrides?: ReadonlyMap<string, number>) =>
    buildSchedule({
      bots,
      params,
      seed: SEED,
      seasonStart: SEASON_START,
      runDate: RUN_DATE,
      targetMatches: 12,
      ceilingRp: CEILING_RP,
      categoryIds: ['cat-1', 'cat-2', 'cat-3'],
      manifestHash: 'seed-solver-test',
      seedOverrides,
    });
  const solved = solveSeeds({
    bots,
    ceilingRp: CEILING_RP,
    seed: SEED,
    planFinalRp: (seedByUserId) =>
      new Map(plan(seedByUserId).finalBots.map((bot) => [bot.userId, bot.rp])),
  });
  return { solved, schedule: plan(solved.seedByUserId) };
}

function tierCounts(rps: number[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rp of rps) counts.set(tierFromRp(rp), (counts.get(tierFromRp(rp)) ?? 0) + 1);
  return counts;
}

describe('seed solver — FINAL ladder matches the S2 target shape', () => {
  it('lands the post-Stage-B tier histogram on the target within tolerance', () => {
    const bots = makeBots(200);
    const { solved, schedule } = solveFor(bots);

    const targetCounts = tierCounts([...solved.targetByUserId.values()]);
    const finalCounts = tierCounts(schedule.finalBots.map((bot) => bot.rp));

    // Stage B settles on a coarse ±25/±50 lattice and bots clamp at RP 0, so the
    // histogram is matched within a per-tier band rather than exactly.
    const tolerance = Math.ceil(bots.length * 0.08);
    for (const [tier, target] of targetCounts) {
      expect(Math.abs((finalCounts.get(tier) ?? 0) - target)).toBeLessThanOrEqual(tolerance);
    }
  });

  it('keeps every FINAL RP inside [0, ceiling]', () => {
    const { schedule } = solveFor(makeBots(200));
    for (const bot of schedule.finalBots) {
      expect(bot.rp).toBeGreaterThanOrEqual(0);
      expect(bot.rp).toBeLessThanOrEqual(CEILING_RP);
    }
  });

  it('keeps every solved SEED inside [0, ceiling]', () => {
    const { solved } = solveFor(makeBots(200));
    for (const rp of solved.seedByUserId.values()) {
      expect(rp).toBeGreaterThanOrEqual(0);
      expect(rp).toBeLessThanOrEqual(CEILING_RP);
    }
  });

  it('reduces the rank residual well below the uncorrected inflation', () => {
    const { solved } = solveFor(makeBots(200));
    // Seeding the target directly leaves a mean drift near +174 RP; rank-matching
    // must pull the worst rank residual down to roughly one lattice step.
    expect(solved.maxResidual).toBeLessThan(200);
    expect(solved.iterations).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic — same seed and roster produce identical solved seeds', () => {
    const a = solveFor(makeBots(120)).solved;
    const b = solveFor(makeBots(120)).solved;
    expect([...a.seedByUserId.entries()].sort()).toEqual([...b.seedByUserId.entries()].sort());
  });

  it('feeds the scheduler the solved seeds (seededBots reflects the override)', () => {
    const { solved, schedule } = solveFor(makeBots(120));
    for (const bot of schedule.seededBots) {
      expect(bot.seededRp).toBe(solved.seedByUserId.get(bot.userId));
    }
  });
});
