import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import {
  parsePossessionState,
  reservedImageMcqForHalf,
  toMatchStatePayload,
} from '../../src/realtime/possession-state.js';

const RESERVED_H1 = { questionId: 'q-half1', imageUrl: 'https://cdn.example.com/h1.png' };
const RESERVED_H2 = { questionId: 'q-half2', imageUrl: 'https://cdn.example.com/h2.png' };

function stateWithReservations() {
  const state = createInitialPossessionState('ranked_sim');
  state.imageMcq = { half1: RESERVED_H1, half2: RESERVED_H2 };
  return state;
}

describe('image MCQ reservation state', () => {
  it('initial state has an empty reservation map (not attempted)', () => {
    const state = createInitialPossessionState('ranked_sim');
    expect(state.imageMcq).toEqual({});
    expect(reservedImageMcqForHalf(state)).toBeUndefined();
  });

  it('reservedImageMcqForHalf returns the reservation for the current half', () => {
    const state = stateWithReservations();
    expect(reservedImageMcqForHalf(state)).toEqual(RESERVED_H1);
    state.half = 2;
    expect(reservedImageMcqForHalf(state)).toEqual(RESERVED_H2);
  });

  describe('parsePossessionState', () => {
    it('round-trips valid reservations through JSON', () => {
      const state = stateWithReservations();
      const parsed = parsePossessionState(JSON.parse(JSON.stringify(state)));
      expect(parsed.imageMcq).toEqual({ half1: RESERVED_H1, half2: RESERVED_H2 });
    });

    it('preserves the explicit null marker (attempted, none available)', () => {
      const state = createInitialPossessionState('ranked_sim');
      state.imageMcq = { half1: null };
      const parsed = parsePossessionState(JSON.parse(JSON.stringify(state)));
      expect(parsed.imageMcq?.half1).toBeNull();
      expect(parsed.imageMcq?.half2).toBeUndefined();
    });

    it('drops malformed reservations', () => {
      const state = createInitialPossessionState('ranked_sim');
      const raw = JSON.parse(JSON.stringify(state));
      raw.imageMcq = {
        half1: { questionId: '', imageUrl: 'https://cdn.example.com/x.png' },
        half2: { questionId: 'q', imageUrl: 42 },
      };
      const parsed = parsePossessionState(raw);
      expect(parsed.imageMcq).toEqual({});
    });

    it('tolerates legacy payloads without imageMcq', () => {
      const state = createInitialPossessionState('ranked_sim');
      const raw = JSON.parse(JSON.stringify(state));
      delete raw.imageMcq;
      const parsed = parsePossessionState(raw);
      expect(parsed.imageMcq).toEqual({});
    });
  });

  describe('toMatchStatePayload preloadImageUrls', () => {
    it('carries the current half reservation image URL', () => {
      const state = stateWithReservations();
      expect(toMatchStatePayload('m1', state).preloadImageUrls).toEqual([RESERVED_H1.imageUrl]);
      state.half = 2;
      expect(toMatchStatePayload('m1', state).preloadImageUrls).toEqual([RESERVED_H2.imageUrl]);
    });

    it('is empty when nothing is reserved or reservation came up empty', () => {
      const state = createInitialPossessionState('ranked_sim');
      expect(toMatchStatePayload('m1', state).preloadImageUrls).toEqual([]);
      state.imageMcq = { half1: null };
      expect(toMatchStatePayload('m1', state).preloadImageUrls).toEqual([]);
    });
  });
});
