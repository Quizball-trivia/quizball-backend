import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

// Resume shifts currentQuestion.shownAt/deadlineAt forward by the pause so
// the scoring clock excludes the disconnect. But resolveAnswerElapsedMs
// PREFERS the recorded reveal ack (cache.revealAcks[userId].revealAtMs), and
// that ack — plus its persisted `r:{userId}` overlay field, which wins over
// the blob on every cache read — stayed at its pre-pause value. A player's
// time_ms after resume therefore included the whole pause, flipping the
// penalty speed tie-break and inflating normal-round times.

const getMatchCacheOrRebuildMock = vi.fn();
const setMatchCacheMock = vi.fn();

// Stateful fake Redis: string values for the cache blob, hashes for the
// per-question answer overlay. hSetNX (how reveal acks are committed) must
// NOT be what the shift uses — it would silently keep the stale value.
type FakeRedis = {
  isOpen: boolean;
  values: Map<string, string>;
  hashes: Map<string, Map<string, string>>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  hSet: ReturnType<typeof vi.fn>;
  hSetNX: ReturnType<typeof vi.fn>;
  hGetAll: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
};
let redis: FakeRedis;

function createRedis(): FakeRedis {
  const values = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const hash = (key: string) => {
    const existing = hashes.get(key);
    if (existing) return existing;
    const created = new Map<string, string>();
    hashes.set(key, created);
    return created;
  };
  return {
    isOpen: true,
    values,
    hashes,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
    }),
    hSet: vi.fn(async (key: string, fields: Record<string, string>) => {
      for (const [field, value] of Object.entries(fields)) hash(key).set(field, value);
      return Object.keys(fields).length;
    }),
    hSetNX: vi.fn(async (key: string, field: string, value: string) => {
      if (hash(key).has(field)) return false;
      hash(key).set(field, value);
      return true;
    }),
    hGetAll: vi.fn(async (key: string) => Object.fromEntries(hashes.get(key) ?? [])),
    expire: vi.fn(async () => true),
  };
}

vi.mock('../../src/core/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/core/metrics.js', () => ({
  appMetrics: { questionGenerationDuration: { record: vi.fn() }, cacheRebuilds: { add: vi.fn() } },
}));

vi.mock('../../src/core/tracing.js', () => ({
  withSpan: async (_name: string, _attributes: unknown, work: (span: unknown) => Promise<unknown>) =>
    work({ setAttribute: vi.fn(), setAttributes: vi.fn() }),
}));

vi.mock('../../src/modules/matches/match-questions.repo.js', () => ({
  matchQuestionsRepo: { setQuestionTiming: vi.fn(async () => undefined) },
}));

vi.mock('../../src/modules/matches/match-answers.repo.js', () => ({
  matchAnswersRepo: {},
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {},
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: { getMatch: vi.fn(), touchMatchRound: vi.fn(), setMatchStatePayload: vi.fn() },
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: { listAllRankedEligibleCategories: vi.fn(async () => []) },
}));

vi.mock('../../src/modules/matches/matches.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/matches/matches.service.js')>();
  return { ...actual, matchesService: { buildMatchQuestionPayload: vi.fn() } };
});

// Keep the real match-cache module (the reveal-ack shift, commitCachedRevealAck
// and getMatchCache's overlay merge all live there); only stub the rebuild
// entry point and the blob write, which we redirect into the fake Redis so a
// subsequent real getMatchCache() read goes through the genuine merge path.
vi.mock('../../src/realtime/match-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/match-cache.js')>();
  return {
    ...actual,
    getMatchCacheOrRebuild: (...args: unknown[]) => getMatchCacheOrRebuildMock(...args),
    setMatchCache: (...args: unknown[]) => setMatchCacheMock(...args),
  };
});

vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  cancelRealtimeTimer: vi.fn(async () => undefined),
  hasPendingRealtimeTimer: vi.fn(async () => false),
  scheduleRealtimeTimer: vi.fn(async () => undefined),
}));

vi.mock('../../src/realtime/possession-match-flow.js', () => ({
  ensureHalftimeCategories: vi.fn(),
  fireAndForget: vi.fn(),
  resolveAiUserIdForMatch: vi.fn(async () => null),
  resolvePossessionRound: vi.fn(),
  scheduleFinalizeHalftime: vi.fn(),
  scheduleHalftimeTimeout: vi.fn(),
  schedulePossessionAiAnswer: vi.fn(async () => undefined),
  schedulePossessionAiHalftimeBan: vi.fn(),
}));

vi.mock('../../src/realtime/possession-completion.js', () => ({
  completePossessionMatch: vi.fn(),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redis,
}));

vi.mock('../../src/realtime/services/dev-realtime.service.js', () => ({
  checkDevPauseAndDefer: vi.fn(async () => false),
}));

vi.mock('../../src/realtime/services/ranked-no-contest.service.js', () => ({
  finalizeRankedMatchAsNoContest: vi.fn(),
}));

vi.mock('../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalResultsPayload: vi.fn(),
  emitFinalResultsToMatchParticipants: vi.fn(),
}));

vi.mock('../../src/realtime/services/match-entry.service.js', () => ({
  markMatchEnteredForRoom: vi.fn(async () => undefined),
  markMatchEnteredForSocket: vi.fn(async () => undefined),
}));

import { resumePossessionMatchQuestion } from '../../src/realtime/possession-question-dispatch.js';
import {
  commitCachedRevealAck,
  getMatchCache,
  matchAnswersOverlayKey,
  matchCacheKey,
} from '../../src/realtime/match-cache.js';
import { resolveAnswerElapsedMs } from '../../src/realtime/possession-timing.js';

const MATCH_ID = 'match-resume';
const Q_INDEX = 4;
const T = new Date('2026-07-04T12:00:00.000Z').getTime();
const QUESTION_TIME_MS = 10_000;
const U1_REVEAL_AT = T + 1_000;
const PAUSE_STARTED_AT = T + 3_000;
const RESUMED_AT = T + 8_000; // 5s pause
const PAUSE_MS = RESUMED_AT - PAUSE_STARTED_AT;

function makeCache(): MatchCache {
  const state = createInitialPossessionState('ranked_sim');
  state.phase = 'PENALTY_SHOOTOUT';
  state.currentQuestion = { qIndex: Q_INDEX, phaseKind: 'penalty', phaseRound: 1, shooterSeat: 1, attackerSeat: null };
  return {
    matchId: MATCH_ID,
    status: 'active',
    mode: 'ranked',
    totalQuestions: 12,
    categoryAId: 'cat-a',
    categoryBId: 'cat-b',
    startedAt: new Date(T - 60_000).toISOString(),
    players: [
      { userId: 'u1', seat: 1, totalPoints: 0, correctAnswers: 0, goals: 0, penaltyGoals: 0, avgTimeMs: null },
      { userId: 'u2', seat: 2, totalPoints: 0, correctAnswers: 0, goals: 0, penaltyGoals: 0, avgTimeMs: null },
    ],
    currentQIndex: Q_INDEX,
    statePayload: state,
    currentQuestion: {
      qIndex: Q_INDEX,
      kind: 'multipleChoice',
      questionId: 'question-1',
      correctIndex: 1,
      phaseKind: 'penalty',
      phaseRound: 1,
      shooterSeat: 1,
      attackerSeat: null,
      shownAt: new Date(T).toISOString(),
      deadlineAt: new Date(T + QUESTION_TIME_MS).toISOString(),
      questionDTO: { kind: 'multipleChoice', id: 'question-1', prompt: { en: 'Q?' }, options: [], categoryName: { en: 'C' } } as never,
      evaluation: { kind: 'multipleChoice', correctIndex: 1 },
      reveal: { kind: 'multipleChoice', correctIndex: 1 },
    },
    answers: {},
    // u2 acked a PREVIOUS question (stale entry) and must be left alone.
    revealAcks: {
      u2: { qIndex: Q_INDEX - 1, revealAtMs: T - 30_000 },
    },
    clueReveals: {},
  };
}

function createIo(): QuizballServer {
  return { to: vi.fn(() => ({ emit: vi.fn() })) } as unknown as QuizballServer;
}

describe('resumePossessionMatchQuestion reveal-ack timing', () => {
  let cache: MatchCache;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useRealTimers();
    redis = createRedis();
    cache = makeCache();
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);
    // Persist the blob the way the real setMatchCache does, so a real
    // getMatchCache() afterwards reads it back and merges the overlay.
    setMatchCacheMock.mockImplementation(async (next: MatchCache) => {
      redis.values.set(matchCacheKey(next.matchId), JSON.stringify(next));
    });
    // u1 acked the reveal 1s after shownAt, through the real commit path
    // (in-memory + hSetNX into the overlay).
    cache.revealAcks!.u1 = { qIndex: Q_INDEX, revealAtMs: U1_REVEAL_AT };
    expect(await commitCachedRevealAck(cache, 'u1', U1_REVEAL_AT)).toBe(true);
    expect(redis.hashes.get(matchAnswersOverlayKey(MATCH_ID, Q_INDEX))?.get('r:u1')).toBe(String(U1_REVEAL_AT));
    redis.hSetNX.mockClear();
  });

  it('excludes the pause from the reveal-ack elapsed time after resume', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(RESUMED_AT));

    const resumed = await resumePossessionMatchQuestion(createIo(), MATCH_ID, Q_INDEX, PAUSE_STARTED_AT);
    expect(resumed).toBe(true);

    // Sanity: the question clock itself was shifted by the pause.
    expect(new Date(cache.currentQuestion!.shownAt!).getTime()).toBe(T + PAUSE_MS);

    // u1 answers 500ms after resume. They played 2s before the pause
    // (ack at T+1s, pause at T+3s), so the authoritative elapsed is 2.5s.
    const ANSWERED_AT = RESUMED_AT + 500;
    const elapsed = resolveAnswerElapsedMs({
      revealAtMs: cache.revealAcks?.u1?.revealAtMs,
      shownAt: cache.currentQuestion!.shownAt,
      deadlineAt: cache.currentQuestion!.deadlineAt,
      nowMs: ANSWERED_AT,
      clientTimeMs: 2_500,
      questionTimeMs: QUESTION_TIME_MS,
    });
    expect(elapsed.source).toBe('reveal_ack');
    expect(elapsed.elapsedMs).toBe(2_500);
    expect(cache.revealAcks?.u1).toEqual({ qIndex: Q_INDEX, revealAtMs: U1_REVEAL_AT + PAUSE_MS });

    // The stale ack for a previous question is left alone.
    expect(cache.revealAcks?.u2).toEqual({ qIndex: Q_INDEX - 1, revealAtMs: T - 30_000 });
  });

  it('overwrites the persisted r:<userId> overlay field so a cache re-read sees the shifted ack', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(RESUMED_AT));

    await resumePossessionMatchQuestion(createIo(), MATCH_ID, Q_INDEX, PAUSE_STARTED_AT);

    const overlayKey = matchAnswersOverlayKey(MATCH_ID, Q_INDEX);
    // hSet (overwrite), never hSetNX — the field already exists from the ack commit.
    expect(redis.hSet).toHaveBeenCalledWith(overlayKey, { 'r:u1': String(U1_REVEAL_AT + PAUSE_MS) });
    expect(redis.hSetNX).not.toHaveBeenCalled();
    expect(redis.hashes.get(overlayKey)?.get('r:u1')).toBe(String(U1_REVEAL_AT + PAUSE_MS));
    // Blob write happened after the in-memory shift.
    expect(setMatchCacheMock).toHaveBeenCalledWith(cache);

    // A fresh read (e.g. on another replica, or after the in-memory copy is
    // dropped) merges the overlay back into revealAcks: it must be the shifted
    // value, not the pre-pause one.
    vi.useRealTimers();
    const reread = await getMatchCache(MATCH_ID);
    expect(reread).not.toBeNull();
    expect(reread!.revealAcks?.u1).toEqual({ qIndex: Q_INDEX, revealAtMs: U1_REVEAL_AT + PAUSE_MS });
    expect(reread!.currentQuestion?.shownAt).toBe(new Date(T + PAUSE_MS).toISOString());
  });

  it('re-bases an ack received DURING the pause to the resume moment instead of pushing it into the future', async () => {
    // The reveal handler accepts acks while the match is paused (e.g. the
    // opponent's client re-rendered the question during the other player's
    // disconnect). Shifting that ack by the whole pause lands it AFTER the
    // resume, so the player's next answer measures ~0 ms and scores maximum
    // points — enough to flip a penalty duel. No play time elapsed before
    // the resume for such an ack, so it must measure from the resume.
    const IN_PAUSE_ACK_AT = PAUSE_STARTED_AT + 2_000;
    cache.revealAcks!.u2 = { qIndex: Q_INDEX, revealAtMs: IN_PAUSE_ACK_AT };
    expect(await commitCachedRevealAck(cache, 'u2', IN_PAUSE_ACK_AT)).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(RESUMED_AT));

    await resumePossessionMatchQuestion(createIo(), MATCH_ID, Q_INDEX, PAUSE_STARTED_AT);

    const ANSWERED_AT = RESUMED_AT + 500;
    const elapsed = resolveAnswerElapsedMs({
      revealAtMs: cache.revealAcks?.u2?.revealAtMs,
      shownAt: cache.currentQuestion!.shownAt,
      deadlineAt: cache.currentQuestion!.deadlineAt,
      nowMs: ANSWERED_AT,
      clientTimeMs: 500,
      questionTimeMs: QUESTION_TIME_MS,
    });
    expect(elapsed.source).toBe('reveal_ack');
    expect(elapsed.elapsedMs).toBe(500);
    expect(cache.revealAcks?.u2).toEqual({ qIndex: Q_INDEX, revealAtMs: RESUMED_AT });
    // The pre-pause ack still gets the plain shift.
    expect(cache.revealAcks?.u1).toEqual({ qIndex: Q_INDEX, revealAtMs: U1_REVEAL_AT + PAUSE_MS });
    // Overlay mirrors both.
    const overlay = redis.hashes.get(matchAnswersOverlayKey(MATCH_ID, Q_INDEX));
    expect(overlay?.get('r:u2')).toBe(String(RESUMED_AT));
    expect(overlay?.get('r:u1')).toBe(String(U1_REVEAL_AT + PAUSE_MS));
  });
});
