import { describe, it, expect } from 'vitest';
import { FULL_DURATION_MS } from '../../src/modules/bots/calibration/constants.js';
import { getQuestionDurationMs } from '../../src/realtime/possession-state.js';

/**
 * The calibration pipeline intentionally hard-codes the full question durations
 * (constants.ts) instead of importing them, so a gameplay refactor cannot
 * silently change what counts as a timeout backfill. This guard asserts the
 * hard-coded copies still match the live engine, catching drift.
 */
describe('FULL_DURATION_MS mirrors the engine', () => {
  it('matches getQuestionDurationMs for every kind', () => {
    expect(FULL_DURATION_MS.multipleChoice).toBe(getQuestionDurationMs('multipleChoice'));
    expect(FULL_DURATION_MS.countdown).toBe(getQuestionDurationMs('countdown'));
    expect(FULL_DURATION_MS.putInOrder).toBe(getQuestionDurationMs('putInOrder'));
    // clues with the default full 5-clue count
    expect(FULL_DURATION_MS.clues).toBe(getQuestionDurationMs('clues', 5));
  });
});
