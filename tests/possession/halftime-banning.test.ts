import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import { __possessionInternals } from '../../src/realtime/possession-match-flow.js';

const { resolveHalftimeResult } = __possessionInternals;

describe('halftime category banning', () => {
  it('keeps one remaining category after two distinct bans', () => {
    const state = createInitialPossessionState();
    state.halftime.categoryOptions = [
      { id: 'cat-a', name: 'A', icon: null },
      { id: 'cat-b', name: 'B', icon: null },
      { id: 'cat-c', name: 'C', icon: null },
    ];
    state.halftime.bans = {
      seat1: 'cat-a',
      seat2: 'cat-b',
    };

    const result = resolveHalftimeResult(state);
    expect(result.seat1Ban).toBe('cat-a');
    expect(result.seat2Ban).toBe('cat-b');
    expect(result.remainingCategoryId).toBe('cat-c');
  });

  it('auto-fills missing/invalid bans and still returns a remaining category', () => {
    const state = createInitialPossessionState();
    state.halftime.categoryOptions = [
      { id: 'cat-a', name: 'A', icon: null },
      { id: 'cat-b', name: 'B', icon: null },
      { id: 'cat-c', name: 'C', icon: null },
    ];
    state.halftime.bans = {
      seat1: null,
      seat2: 'invalid-id',
    };

    const result = resolveHalftimeResult(state);
    expect(result.seat1Ban).toBeTruthy();
    expect(result.seat2Ban).toBeTruthy();
    expect(result.seat1Ban).not.toBe(result.seat2Ban);
    expect(result.remainingCategoryId).toBeTruthy();
    expect(result.remainingCategoryId).not.toBe(result.seat1Ban);
    expect(result.remainingCategoryId).not.toBe(result.seat2Ban);
  });

  it('returns null remaining category when options are empty', () => {
    const state = createInitialPossessionState();
    state.halftime.categoryOptions = [];
    state.halftime.bans = { seat1: null, seat2: null };

    const result = resolveHalftimeResult(state);
    expect(result.remainingCategoryId).toBeNull();
  });
});
