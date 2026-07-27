/**
 * Pure (no-DB) unit tests for the burn-in scheduler + simulator: determinism,
 * hard-ceiling enforcement via win assignment, and per-bot feasibility.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSchedule } from '../../scripts/bot-burnin/scheduler.js';
import { parseBotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import type { BurnInBot } from '../../scripts/bot-burnin/types.js';

const params = parseBotModelParams(
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures/params.json'), 'utf8')),
);

const SEASON_START = new Date('2026-07-21T00:00:00Z');
const RUN_DATE = new Date('2026-07-28T00:00:00Z');

function makeBots(n: number): BurnInBot[] {
  const bots: BurnInBot[] = [];
  for (let i = 0; i < n; i++) {
    // Spread hidden skill across the theta range the fCurve covers.
    const baseSkill = -0.9 + (i / (n - 1)) * 2.0;
    bots.push({
      userId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      nickname: `bot_${i}`,
      baseSkill,
      dailyCap: 6,
      schedule: { activeHours: [], sessionMax: 4, intraSessionGapMin: 20 },
      status: 'active',
      rp: 0,
      placementPlayed: 0,
      placementWins: 0,
      placementStatus: 'unplaced',
      currentWinStreak: 0,
    });
  }
  return bots;
}

const baseOpts = {
  params,
  seed: 20260721,
  seasonStart: SEASON_START,
  runDate: RUN_DATE,
  targetMatches: 22,
  ceilingRp: 1300,
  categoryIds: ['cat-1', 'cat-2', 'cat-3'],
};

describe('buildSchedule determinism', () => {
  it('produces an identical plan for the same seed', () => {
    const a = buildSchedule({ ...baseOpts, bots: makeBots(20) });
    const b = buildSchedule({ ...baseOpts, bots: makeBots(20) });
    expect(a.fixtures.length).toBe(b.fixtures.length);
    expect(a.fixtures.map((f) => f.key)).toEqual(b.fixtures.map((f) => f.key));
    expect(a.fixtures.map((f) => f.winnerUserId)).toEqual(b.fixtures.map((f) => f.winnerUserId));
    expect(a.finalBots.map((x) => x.rp)).toEqual(b.finalBots.map((x) => x.rp));
  });

  it('a different seed changes the plan', () => {
    const a = buildSchedule({ ...baseOpts, bots: makeBots(20) });
    const b = buildSchedule({ ...baseOpts, bots: makeBots(20), seed: 999 });
    expect(a.fixtures.map((f) => f.winnerUserId)).not.toEqual(b.fixtures.map((f) => f.winnerUserId));
  });
});

describe('hard ceiling', () => {
  it('no bot ends above the ceiling RP', () => {
    const ceilingRp = 900;
    const { finalBots } = buildSchedule({ ...baseOpts, bots: makeBots(24), ceilingRp });
    const maxRp = Math.max(...finalBots.map((b) => b.rp));
    expect(maxRp).toBeLessThanOrEqual(ceilingRp);
  });
});

describe('per-bot feasibility', () => {
  it('a retired bot plays no fixtures; a low-cap bot plays fewer', () => {
    const bots = makeBots(12);
    bots[0].status = 'retired';
    bots[1].dailyCap = 1;
    bots[2].dailyCap = 6;
    const { fixtures } = buildSchedule({ ...baseOpts, bots, targetMatches: 30 });
    const count = (id: string) =>
      fixtures.filter((f) => f.botAUserId === id || f.botBUserId === id).length;
    expect(count(bots[0].userId)).toBe(0);
    expect(count(bots[1].userId)).toBeLessThan(count(bots[2].userId));
  });

  it('placement-first: a bot’s first three fixtures carry placement context', () => {
    const { fixtures } = buildSchedule({ ...baseOpts, bots: makeBots(16) });
    const target = fixtures[0]?.botAUserId;
    expect(target).toBeDefined();
    const forBot = fixtures
      .filter((f) => f.botAUserId === target || f.botBUserId === target)
      .slice(0, 3);
    expect(forBot.length).toBeGreaterThan(0);
    for (const f of forBot) expect(f.isPlacementContext).toBe(true);
  });
});
