import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBotModelParams, type BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import {
  decideClue,
  decideCountdownFoundCount,
  decidePutInOrderCorrectCount,
  type PersistentBotSkillInputs,
} from '../../src/realtime/persistent-bot-gameplay.js';

// The frozen calibration artifact, vendored into the repo so tests run on CI /
// any checkout without a home-dir absolute path.
const PARAMS_PATH = resolve(__dirname, 'fixtures/params.json');
const params: BotModelParams = parseBotModelParams(
  JSON.parse(readFileSync(PARAMS_PATH, 'utf8')),
);

const inputs: PersistentBotSkillInputs = {
  currentRp: 2000,
  personalOffset: 0.2,
  governorAdjustment: 0,
  categoryAffinities: {},
  dailyFormSeed: '2026-07-28',
  thetaCeilingBound: 2.5,
};

const keys = { botId: 'b1', matchId: 'm1', questionId: 'q1' };

describe('persistent bot per-format decisions are pinned (immutable)', () => {
  it('pinned distribution replays identically', () => {
    const countdownDist = { '3': 5, '5': 10, '6': 8 };
    const first = decideCountdownFoundCount(params, inputs, countdownDist, 8, keys);
    const second = decideCountdownFoundCount(params, inputs, countdownDist, 8, keys);
    expect(second).toBe(first);

    const pioDist = { '2': 4, '4': 12 };
    const pioFirst = decidePutInOrderCorrectCount(params, inputs, pioDist, 6, keys);
    const pioSecond = decidePutInOrderCorrectCount(params, inputs, pioDist, 6, keys);
    expect(pioSecond).toBe(pioFirst);

    const clueDist = { '0': 4, '1': 8 };
    const clueFirst = decideClue(params, inputs, clueDist, 5, keys);
    const clueSecond = decideClue(params, inputs, clueDist, 5, keys);
    expect(clueSecond).toEqual(clueFirst);
  });

  it('a refreshed (different) distribution generally changes the outcome — so pinning matters', () => {
    const total = 8;
    const distLow = { '1': 20 };
    const distHigh = { '8': 20 };

    const foundLow = decideCountdownFoundCount(params, inputs, distLow, total, keys);
    const foundHigh = decideCountdownFoundCount(params, inputs, distHigh, total, keys);

    expect(foundLow).not.toBe(foundHigh);
  });

  it('same seed + same dist across two "reads" (schedule vs commit) is identical', () => {
    const clueDist = { '0': 4, '1': 8 };
    const scheduled = decideClue(params, inputs, clueDist, 5, keys);
    const committed = decideClue(params, inputs, clueDist, 5, keys);
    expect(committed).toEqual(scheduled);
  });
});
