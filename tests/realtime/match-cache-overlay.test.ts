import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';

const store = vi.hoisted(() => ({
  values: new Map<string, string>(),
  hashes: new Map<string, Map<string, string>>(),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({
    isOpen: true,
    async get(key: string): Promise<string | null> {
      return store.values.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<'OK'> {
      store.values.set(key, value);
      return 'OK';
    },
    async del(keys: string | string[]): Promise<number> {
      const list = Array.isArray(keys) ? keys : [keys];
      let removed = 0;
      for (const key of list) {
        if (store.values.delete(key)) removed += 1;
        if (store.hashes.delete(key)) removed += 1;
      }
      return removed;
    },
    async hSet(key: string, fields: Record<string, string>): Promise<number> {
      const hash = store.hashes.get(key) ?? new Map<string, string>();
      for (const [field, value] of Object.entries(fields)) hash.set(field, value);
      store.hashes.set(key, hash);
      return Object.keys(fields).length;
    },
    async hSetNX(key: string, field: string, value: string): Promise<boolean> {
      const hash = store.hashes.get(key) ?? new Map<string, string>();
      if (hash.has(field)) {
        store.hashes.set(key, hash);
        return false;
      }
      hash.set(field, value);
      store.hashes.set(key, hash);
      return true;
    },
    async hGetAll(key: string): Promise<Record<string, string>> {
      return Object.fromEntries(store.hashes.get(key) ?? new Map());
    },
    async expire(): Promise<boolean> {
      return true;
    },
  }),
}));

import {
  buildInitialCache,
  commitCachedAnswer,
  commitCachedRevealAck,
  getMatchCache,
  matchAnswersOverlayKey,
  matchCacheKey,
  setMatchCache,
  type CachedAnswer,
  type MatchCache,
} from '../../src/realtime/match-cache.js';

const MATCH_ID = 'm-overlay-1';

function createCache(): MatchCache {
  const state = createInitialPossessionState();
  const cache = buildInitialCache({
    match: {
      id: MATCH_ID,
      status: 'active',
      mode: 'friendly',
      total_questions: 12,
      category_a_id: 'cat-a',
      category_b_id: 'cat-b',
      started_at: new Date().toISOString(),
      current_q_index: 3,
      state_payload: state,
    },
    players: [
      { user_id: 'u1', seat: 1, total_points: 100, correct_answers: 1, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { user_id: 'u2', seat: 2, total_points: 80, correct_answers: 1, goals: 0, penalty_goals: 0, avg_time_ms: null },
    ],
    state,
  });
  cache.currentQIndex = 3;
  return cache;
}

function createAnswer(userId: string): CachedAnswer {
  return {
    userId,
    questionKind: 'multipleChoice',
    selectedIndex: 1,
    isCorrect: true,
    timeMs: 3000,
    pointsEarned: 70,
    phaseKind: 'normal',
    phaseRound: null,
    shooterSeat: null,
    answeredAt: new Date().toISOString(),
  };
}

describe('match cache answer overlay (db-optimize #7)', () => {
  beforeEach(() => {
    store.values.clear();
    store.hashes.clear();
  });

  it('commitCachedAnswer writes only the per-question overlay, not the blob', async () => {
    const cache = createCache();
    await setMatchCache(cache);
    const blobBefore = store.values.get(matchCacheKey(MATCH_ID));

    const answer = createAnswer('u1');
    cache.answers['u1'] = answer;
    const player = cache.players.find((candidate) => candidate.userId === 'u1')!;
    player.totalPoints += answer.pointsEarned;
    player.correctAnswers += 1;
    await commitCachedAnswer(cache, answer);

    // Blob untouched — the hot path no longer re-serializes the whole cache.
    expect(store.values.get(matchCacheKey(MATCH_ID))).toBe(blobBefore);
    const overlay = store.hashes.get(matchAnswersOverlayKey(MATCH_ID, 3));
    expect(overlay?.get('a:u1')).toBeDefined();
    expect(JSON.parse(overlay!.get('t:u1')!)).toEqual({ totalPoints: 170, correctAnswers: 2 });
  });

  it('getMatchCache merges overlay answers and player totals over the blob', async () => {
    const cache = createCache();
    await setMatchCache(cache); // blob has no answers, u1 totals 100/1

    const answer = createAnswer('u1');
    const committing = createCache();
    committing.answers['u1'] = answer;
    const player = committing.players.find((candidate) => candidate.userId === 'u1')!;
    player.totalPoints = 170;
    player.correctAnswers = 2;
    await commitCachedAnswer(committing, answer);

    const merged = await getMatchCache(MATCH_ID);
    expect(merged?.answers['u1']?.pointsEarned).toBe(70);
    expect(merged?.players.find((candidate) => candidate.userId === 'u1')).toMatchObject({
      totalPoints: 170,
      correctAnswers: 2,
    });
    // u2 untouched by the overlay.
    expect(merged?.answers['u2']).toBeUndefined();
    expect(merged?.players.find((candidate) => candidate.userId === 'u2')?.totalPoints).toBe(80);
  });

  it('advancing the round orphans the previous overlay (qIndex-namespaced)', async () => {
    const cache = createCache();
    const answer = createAnswer('u1');
    cache.answers['u1'] = answer;
    await commitCachedAnswer(cache, answer);

    // Round resolves: blob written with cleared answers and the next qIndex.
    cache.answers = {};
    cache.currentQIndex = 4;
    await setMatchCache(cache);

    const merged = await getMatchCache(MATCH_ID);
    expect(merged?.currentQIndex).toBe(4);
    expect(merged?.answers).toEqual({});
  });

  it('commitCachedRevealAck writes a first-wins per-question overlay field', async () => {
    const cache = createCache();
    await setMatchCache(cache);
    const blobBefore = store.values.get(matchCacheKey(MATCH_ID));

    cache.revealAcks = { u1: { qIndex: 3, revealAtMs: 1234 } };
    await expect(commitCachedRevealAck(cache, 'u1', 1234)).resolves.toBe(true);
    cache.revealAcks.u1 = { qIndex: 3, revealAtMs: 5678 };
    await expect(commitCachedRevealAck(cache, 'u1', 5678)).resolves.toBe(false);

    expect(store.values.get(matchCacheKey(MATCH_ID))).toBe(blobBefore);
    const overlay = store.hashes.get(matchAnswersOverlayKey(MATCH_ID, 3));
    expect(overlay?.get('r:u1')).toBe('1234');

    const merged = await getMatchCache(MATCH_ID);
    expect(merged?.revealAcks?.u1).toEqual({ qIndex: 3, revealAtMs: 1234 });
  });
});
