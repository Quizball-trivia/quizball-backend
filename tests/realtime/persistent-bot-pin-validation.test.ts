import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePersistentBotModelPin } from '../../src/realtime/possession-ai.js';
import { HARD_THETA_CEILING_FALLBACK } from '../../src/modules/bots/calibration/hard-clamps.js';

const validParams = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/params.json'), 'utf8'));

function fullPin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paramsVersion: 1,
    params: validParams,
    botUserId: 'bot-1',
    currentRp: 1200,
    personalOffset: 0.2,
    governorAdjustment: 0,
    categoryAffinities: { football: 0.3 },
    dailyFormSeed: '2026-07-28',
    thetaCeilingBound: 2.5,
    ...overrides,
  };
}

const ctx = (pin: unknown) => ({ persistentBotModel: pin });

describe('pin validation — a partial/poisoned pin falls back cleanly (no NaN)', () => {
  it('accepts a fully-valid pin', () => {
    const parsed = parsePersistentBotModelPin(ctx(fullPin()));
    expect(parsed).not.toBeNull();
    expect(parsed!.thetaCeilingBound).toBe(2.5);
  });

  it('returns null when ANY model-read field is missing or non-finite', () => {
    const missing = ['personalOffset', 'governorAdjustment', 'currentRp', 'dailyFormSeed', 'botUserId', 'params'];
    for (const field of missing) {
      const pin = fullPin();
      delete pin[field];
      expect(parsePersistentBotModelPin(ctx(pin)), `missing ${field}`).toBeNull();
    }
    for (const field of ['personalOffset', 'governorAdjustment', 'currentRp']) {
      expect(parsePersistentBotModelPin(ctx(fullPin({ [field]: NaN })) ), `NaN ${field}`).toBeNull();
      expect(parsePersistentBotModelPin(ctx(fullPin({ [field]: Infinity })) ), `Inf ${field}`).toBeNull();
      expect(parsePersistentBotModelPin(ctx(fullPin({ [field]: null })) ), `null ${field}`).toBeNull();
      expect(parsePersistentBotModelPin(ctx(fullPin({ [field]: 'x' })) ), `str ${field}`).toBeNull();
    }
  });

  it('rejects a non-finite thetaCeilingBound but defaults a MISSING one', () => {
    expect(parsePersistentBotModelPin(ctx(fullPin({ thetaCeilingBound: NaN })))).toBeNull();
    const missing = fullPin();
    delete missing.thetaCeilingBound;
    const parsed = parsePersistentBotModelPin(ctx(missing));
    expect(parsed).not.toBeNull();
    expect(parsed!.thetaCeilingBound).toBe(HARD_THETA_CEILING_FALLBACK);
  });

  it('rejects a categoryAffinities map with any non-finite value', () => {
    expect(parsePersistentBotModelPin(ctx(fullPin({ categoryAffinities: { x: NaN } })))).toBeNull();
    expect(parsePersistentBotModelPin(ctx(fullPin({ categoryAffinities: { x: 'y' } })))).toBeNull();
    // A missing/empty affinities map is fine (defaults to {}).
    const empty = fullPin();
    delete empty.categoryAffinities;
    expect(parsePersistentBotModelPin(ctx(empty))).not.toBeNull();
  });

  it('returns null when the pin is absent entirely', () => {
    expect(parsePersistentBotModelPin(null)).toBeNull();
    expect(parsePersistentBotModelPin({})).toBeNull();
    expect(parsePersistentBotModelPin({ persistentBotModel: null })).toBeNull();
  });

  it('a valid pin never yields NaN in any numeric field the model reads', () => {
    const p = parsePersistentBotModelPin(ctx(fullPin()))!;
    for (const v of [p.currentRp, p.personalOffset, p.governorAdjustment, p.thetaCeilingBound]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    for (const v of Object.values(p.categoryAffinities)) expect(Number.isFinite(v)).toBe(true);
  });
});
