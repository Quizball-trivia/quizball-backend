/**
 * PR10 activity scaling: the operator knob that throttles how much the whole
 * roster plays, applied to each bot's generated daily_cap at selection time.
 */
import { describe, it, expect } from 'vitest';
import '../setup.js';
import { operatorDailyCap } from '../../src/modules/synthetic-bots/synthetic-bot-selection.service.js';
import { MAX_DAILY_CAP } from '../../src/modules/bots/tuning/tuning.schemas.js';

const defaults = { activityScale: 1, maxDailyCap: MAX_DAILY_CAP };

describe('PR10 operatorDailyCap', () => {
  it('is a no-op at scale 1 within the rail', () => {
    expect(operatorDailyCap(8, defaults)).toBe(8);
  });

  it('halves the cap at scale 0.5', () => {
    expect(operatorDailyCap(8, { ...defaults, activityScale: 0.5 })).toBe(4);
  });

  it('IDLES the roster completely at scale 0 (the incident lever)', () => {
    // Must reach 0, not floor at 1: "stop the bots playing" has to be reachable.
    expect(operatorDailyCap(12, { ...defaults, activityScale: 0 })).toBe(0);
  });

  it('clamps to the roster-wide max even when scaling up', () => {
    expect(operatorDailyCap(10, { activityScale: 2, maxDailyCap: MAX_DAILY_CAP })).toBe(MAX_DAILY_CAP);
  });

  it('clamps a legacy out-of-rail cap down to the max', () => {
    // Defence in depth with the migration's one-time normalization: even if a
    // row somehow still holds 40, selection never honours more than the rail.
    expect(operatorDailyCap(40, defaults)).toBe(MAX_DAILY_CAP);
  });

  it('honours a tightened roster-wide max', () => {
    expect(operatorDailyCap(10, { activityScale: 1, maxDailyCap: 3 })).toBe(3);
  });

  it('never returns a negative cap', () => {
    expect(operatorDailyCap(5, { activityScale: -1, maxDailyCap: MAX_DAILY_CAP })).toBe(0);
  });

  it('floors fractional results (a partial match is not a match)', () => {
    expect(operatorDailyCap(5, { ...defaults, activityScale: 0.3 })).toBe(1);
  });
});
