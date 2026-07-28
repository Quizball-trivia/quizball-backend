/**
 * Pure (no-DB) unit tests for the burn-in scheduler + simulator: determinism,
 * hard-ceiling enforcement via win assignment, per-bot feasibility, and the
 * session/01:23-boundary enforcement Sol's finding 7 reproduced.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSchedule } from '../../scripts/bot-burnin/scheduler.js';
import { parseBotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import type { BurnInBot, BotSchedule } from '../../scripts/bot-burnin/types.js';

const params = parseBotModelParams(
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures/params.json'), 'utf8')),
);

const SEASON_START = new Date('2026-07-21T00:00:00Z');
const RUN_DATE = new Date('2026-07-28T00:00:00Z');
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;

function makeBots(n: number, schedule?: Partial<BotSchedule>): BurnInBot[] {
  const bots: BurnInBot[] = [];
  for (let i = 0; i < n; i++) {
    const baseSkill = -0.9 + (i / (n - 1)) * 2.0;
    bots.push({
      userId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      nickname: `bot_${i}`,
      baseSkill,
      dailyCap: 6,
      schedule: { activeHours: [], sessionMax: 4, intraSessionGapMin: 20, ...schedule },
      status: 'active',
      // Pristine starting state (the execute gate guarantees this at run time).
      rp: 450,
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
  manifestHash: 'test-manifest-hash',
};

/** Tbilisi minutes-since-midnight for a Date. */
function tbMinOfDay(d: Date): number {
  const t = new Date(d.getTime() + TBILISI_OFFSET_MS);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}
function tbHour(d: Date): number {
  return new Date(d.getTime() + TBILISI_OFFSET_MS).getUTCHours();
}

describe('buildSchedule is a PURE function of immutable inputs', () => {
  it('produces an IDENTICAL plan even when bots carry DIFFERENT live mutable state', () => {
    // The plan simulates from the fixed pristine baseline, so live
    // rp/placement/streak must NOT affect it (the root-cause of the resume
    // instability class). Same manifest inputs → identical fixtures + match ids.
    const pristine = makeBots(16);
    const dirtied = makeBots(16).map((b, i) => ({
      ...b,
      rp: 900 + i * 10, placementStatus: 'placed' as const, placementPlayed: 3,
      placementWins: 2, currentWinStreak: 5,
    }));
    const a = buildSchedule({ ...baseOpts, bots: pristine });
    const b = buildSchedule({ ...baseOpts, bots: dirtied });
    expect(a.fixtures.map((f) => f.matchId)).toEqual(b.fixtures.map((f) => f.matchId));
    expect(a.fixtures.map((f) => f.winnerUserId)).toEqual(b.fixtures.map((f) => f.winnerUserId));
    expect(a.finalBots.map((x) => x.rp)).toEqual(b.finalBots.map((x) => x.rp));
  });
});

describe('buildSchedule determinism', () => {
  it('produces an identical plan for the same seed + manifest', () => {
    const a = buildSchedule({ ...baseOpts, bots: makeBots(20) });
    const b = buildSchedule({ ...baseOpts, bots: makeBots(20) });
    expect(a.fixtures.length).toBe(b.fixtures.length);
    expect(a.fixtures.map((f) => f.key)).toEqual(b.fixtures.map((f) => f.key));
    expect(a.fixtures.map((f) => f.matchId)).toEqual(b.fixtures.map((f) => f.matchId));
    expect(a.fixtures.map((f) => f.winnerUserId)).toEqual(b.fixtures.map((f) => f.winnerUserId));
    expect(a.finalBots.map((x) => x.rp)).toEqual(b.finalBots.map((x) => x.rp));
  });

  it('a different manifest hash changes every fixture key (finding 4)', () => {
    const a = buildSchedule({ ...baseOpts, bots: makeBots(20) });
    const b = buildSchedule({ ...baseOpts, bots: makeBots(20), manifestHash: 'other-hash' });
    // Same plan shape, but keys/matchIds differ because they bind the manifest.
    expect(a.fixtures.length).toBe(b.fixtures.length);
    expect(a.fixtures.map((f) => f.key)).not.toEqual(b.fixtures.map((f) => f.key));
    expect(a.fixtures.map((f) => f.matchId)).not.toEqual(b.fixtures.map((f) => f.matchId));
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

describe('activity window + session shape (finding 7)', () => {
  it('every fixture STARTS and ENDS within 07:00–01:23 (no 01:2x–01:5x spillover)', () => {
    // Sol repro: activeHours:[1] previously produced fixtures at 01:20–01:27 and
    // 01:40–01:46, past the 01:23 boundary. Now nothing may end after 01:23.
    const bots = makeBots(8, { activeHours: [1], sessionMax: 4 });
    const { fixtures } = buildSchedule({ ...baseOpts, bots, targetMatches: 40 });
    for (const f of fixtures) {
      const startMin = tbMinOfDay(f.startedAt);
      const endMin = tbMinOfDay(f.endedAt);
      // Start must be in-window: >= 07:00 OR <= 01:23.
      expect(startMin >= 7 * 60 || startMin <= 83).toBe(true);
      // End must be in-window too (a 01:xx fixture ends by 01:23).
      expect(endMin >= 7 * 60 || endMin <= 83).toBe(true);
      // Specifically: no fixture in the 01:00 hour ends after 01:23.
      if (tbHour(f.startedAt) === 1) expect(endMin).toBeLessThanOrEqual(83);
    }
  });

  it('honors sessionMax: no burst exceeds sessionMax fixtures within the rest gap', () => {
    // Sol repro: sessionMax:2 previously produced three-match bursts.
    const bots = makeBots(10, { activeHours: [], sessionMax: 2, intraSessionGapMin: 10 });
    const { fixtures } = buildSchedule({ ...baseOpts, bots, targetMatches: 40 });
    const REST_GAP_MS = 90 * 60 * 1000;
    // Reconstruct per-bot session bursts from the fixture timeline.
    const byBot = new Map<string, number[]>();
    for (const f of fixtures) {
      for (const id of [f.botAUserId, f.botBUserId]) {
        const arr = byBot.get(id) ?? [];
        arr.push(f.startedAt.getTime());
        byBot.set(id, arr);
      }
    }
    for (const [, startsRaw] of byBot) {
      const starts = [...startsRaw].sort((a, b) => a - b);
      let burst = 0;
      let prevEnd = Number.NEGATIVE_INFINITY;
      for (const s of starts) {
        burst = s - prevEnd <= REST_GAP_MS ? burst + 1 : 1;
        expect(burst).toBeLessThanOrEqual(2);
        prevEnd = s; // conservative: starts are >= a rest gap apart within a burst
      }
    }
  });
});
