/**
 * Pure unit tests: the run manifest hashes the FULL plan (findings 4/5). A
 * change to the calibration params CONTENTS or to any bot's schedule MUST change
 * the manifest hash (and therefore every fixture key).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildManifest, manifestHash } from '../../scripts/bot-burnin/manifest.js';
import { parseBotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import type { BurnInBot } from '../../scripts/bot-burnin/types.js';

const params = parseBotModelParams(
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures/params.json'), 'utf8')),
);

function bot(i: number): BurnInBot {
  return {
    userId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    nickname: `b${i}`, baseSkill: 0.1, dailyCap: 6,
    schedule: { activeHours: [19, 20], sessionMax: 3, intraSessionGapMin: 20 },
    status: 'active', rp: 450, placementPlayed: 0, placementWins: 0,
    placementStatus: 'unplaced', currentWinStreak: 0,
  };
}

const base = {
  seed: 1, env: 'test',
  seasonStart: new Date('2026-07-21T00:00:00Z'),
  runDate: new Date('2026-07-28T00:00:00Z'),
  targetMatches: 22, ceilingMarginRp: 200, ceilingRp: 1300, humanTop10Rp: 1500,
  params, bots: [bot(0), bot(1)], categoryIds: ['c1', 'c2'],
};

describe('manifest hashes the full plan', () => {
  it('is stable for identical inputs and order-independent for the roster', () => {
    const h1 = manifestHash(buildManifest(base));
    const h2 = manifestHash(buildManifest({ ...base, bots: [bot(1), bot(0)] }));
    expect(h1).toBe(h2);
  });

  it('changes when the calibration params CONTENTS change (not just metadata)', () => {
    const h1 = manifestHash(buildManifest(base));
    // Same generatedAt/batchId, different curve value → H MUST change (finding 5).
    const mutated = { ...params, fCurve: params.fCurve.map((k, i) => (i === 0 ? { ...k, skill: k.skill + 0.01 } : k)) };
    const h2 = manifestHash(buildManifest({ ...base, params: mutated }));
    expect(h2).not.toBe(h1);
  });

  it('changes when a bot schedule changes (finding 4)', () => {
    const h1 = manifestHash(buildManifest(base));
    const b0 = { ...bot(0), schedule: { activeHours: [1], sessionMax: 2, intraSessionGapMin: 30 } };
    const h2 = manifestHash(buildManifest({ ...base, bots: [b0, bot(1)] }));
    expect(h2).not.toBe(h1);
  });

  it('changes when seed / target / ceiling change', () => {
    const h1 = manifestHash(buildManifest(base));
    expect(manifestHash(buildManifest({ ...base, seed: 2 }))).not.toBe(h1);
    expect(manifestHash(buildManifest({ ...base, targetMatches: 30 }))).not.toBe(h1);
    expect(manifestHash(buildManifest({ ...base, ceilingRp: 1200 }))).not.toBe(h1);
  });
});
