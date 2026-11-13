import { describe, expect, it } from 'vitest';
import { createGapDedupe } from '../../src/modules/content-gaps/content-gaps.dedupe.js';

describe('createGapDedupe', () => {
  it('one key per scope and normalised name for the window', () => {
    const d = createGapDedupe(1_000, 10);
    expect(d.fresh('s', 'Nóble Nobody', 0)).toBe(true);
    for (const v of ['noble nobody', 'Noble-Nobody', ' NOBLE  NOBODY ']) expect(d.fresh('s', v, 10)).toBe(false);
    expect(d.fresh('other', 'Noble Nobody', 10)).toBe(true);
    expect(d.fresh('s', 'Noble Nobody', 1_001)).toBe(true);
  });

  it('when full of live keys it refuses new names instead of forgetting the window', () => {
    const d = createGapDedupe(1_000, 2);
    expect(d.fresh('s', 'a1', 0)).toBe(true);
    expect(d.fresh('s', 'b2', 0)).toBe(true);
    expect(d.fresh('s', 'c3', 10)).toBe(false);
    expect(d.fresh('s', 'a1', 10)).toBe(false);
    // Expired keys make room again.
    expect(d.fresh('s', 'c3', 1_500)).toBe(true);
  });
});
