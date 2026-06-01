import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import { __possessionInternals } from '../../src/realtime/possession-match-flow.js';
import { transitionAfterHalfBoundary, categoryIdsForCurrentHalf } from '../../src/realtime/possession-resolution.js';
import { parsePossessionState } from '../../src/realtime/possession-state.js';

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

describe('penalty category ban phase', () => {
  it('a draw after the second half enters the HALFTIME penalty-ban interlude, not PENALTY_SHOOTOUT directly', () => {
    const state = createInitialPossessionState();
    state.half = 2;
    state.goals = { seat1: 2, seat2: 2 };

    transitionAfterHalfBoundary(state);

    expect(state.phase).toBe('HALFTIME');
    expect(state.halftime.purpose).toBe('penalty');
    expect(state.halftime.deadlineAt).toBeTruthy();
    // The shootout is initialised later (at finalize), not here.
    expect(state.penalty.round).toBe(0);
  });

  it('a non-draw after the second half completes the match (unchanged)', () => {
    const state = createInitialPossessionState();
    state.half = 2;
    state.goals = { seat1: 3, seat2: 1 };

    transitionAfterHalfBoundary(state);

    expect(state.phase).toBe('COMPLETED');
  });

  it('penalty questions use penaltyCategoryId only during PENALTY_SHOOTOUT', () => {
    const cache = { categoryAId: 'cat-a', categoryBId: 'cat-b' };

    // During the shootout → the penalty (post-ban) category.
    expect(
      categoryIdsForCurrentHalf(
        { half: 2, phase: 'PENALTY_SHOOTOUT', penaltyCategoryId: 'cat-pen' },
        cache,
      ),
    ).toEqual(['cat-pen']);

    // A stale penaltyCategoryId must NOT leak into a normal second half.
    expect(
      categoryIdsForCurrentHalf(
        { half: 2, phase: 'NORMAL_PLAY', penaltyCategoryId: 'cat-pen' },
        cache,
      ),
    ).toEqual(['cat-b']);

    // Falls back to categoryB then A if no penalty category was chosen.
    expect(
      categoryIdsForCurrentHalf(
        { half: 2, phase: 'PENALTY_SHOOTOUT', penaltyCategoryId: null },
        cache,
      ),
    ).toEqual(['cat-b']);
  });

  it('rehydration preserves halftime.purpose = penalty (cache rebuild / restart guard)', () => {
    const state = createInitialPossessionState();
    state.half = 2;
    state.phase = 'HALFTIME';
    state.halftime.purpose = 'penalty';
    state.penaltyCategoryId = 'cat-pen';

    // Round-trip through the sanitizer used on rehydrate.
    const rehydrated = parsePossessionState(JSON.parse(JSON.stringify(state)));

    expect(rehydrated.halftime.purpose).toBe('penalty');
    expect(rehydrated.penaltyCategoryId).toBe('cat-pen');
  });

  it('rehydration defaults legacy state (no purpose) to second_half', () => {
    const state = createInitialPossessionState();
    const raw = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    // Simulate a legacy row that predates the purpose/penaltyCategoryId fields.
    delete (raw.halftime as Record<string, unknown>).purpose;
    delete raw.penaltyCategoryId;

    const rehydrated = parsePossessionState(raw);

    expect(rehydrated.halftime.purpose).toBe('second_half');
    expect(rehydrated.penaltyCategoryId).toBeNull();
  });
});
