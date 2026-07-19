import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';
import type { MatchCache } from '../../src/realtime/match-cache.js';
import { acquireLock } from '../../src/realtime/locks.js';

const getMatchMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const getAnswerForUserMock = vi.fn();
const insertMatchAnswerIfMissingMock = vi.fn();
const updatePlayerTotalsMock = vi.fn();
const recordPartyQuizAnswerIfMissingMock = vi.fn();
const setMatchStatePayloadMock = vi.fn();
const listAnswersForQuestionMock = vi.fn();
const completeMatchMock = vi.fn();
const updatePlayerAvgTimeMock = vi.fn();
const setQuestionTimingMock = vi.fn();
const getMatchQuestionMock = vi.fn();
const deleteMatchCacheMock = vi.fn();
const commitCachedAnswerMock = vi.fn();
const getMatchCacheOrRebuildMock = vi.fn();
const buildMatchQuestionPayloadMock = vi.fn();
const computeAvgTimesMock = vi.fn();
const evaluateAchievementsForMatchMock = vi.fn();
const listUnlockedForMatchMock = vi.fn();
const redisMockState = vi.hoisted(() => ({
  pausedMatches: new Set<string>(),
  open: false,
  failCommands: false,
  sets: new Map<string, Set<string>>(),
  strings: new Map<string, string>(),
}));
const realtimeTimerMocks = vi.hoisted(() => ({
  schedule: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, token: 'lock-token' })),
  releaseLock: vi.fn(async () => undefined),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => {
    const client = {
      isOpen: redisMockState.open,
      exists: async (key: string) => (redisMockState.pausedMatches.has(key) ? 1 : 0),
      sAdd: async (key: string, values: string | string[]) => {
        if (redisMockState.failCommands) throw new Error('redis unavailable');
        const set = redisMockState.sets.get(key) ?? new Set<string>();
        const before = set.size;
        for (const value of Array.isArray(values) ? values : [values]) set.add(value);
        redisMockState.sets.set(key, set);
        return set.size - before;
      },
      expire: async () => true,
      del: async (keys: string | string[]) => {
        let removed = 0;
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (redisMockState.sets.delete(key)) removed += 1;
          if (redisMockState.strings.delete(key)) removed += 1;
        }
        return removed;
      },
      eval: async (_script: string, params: { keys: string[] }) => {
        if (redisMockState.failCommands) throw new Error('redis unavailable');
        const [expectedKey, ackKey, dispatchKey] = params.keys;
        const expected = redisMockState.sets.get(expectedKey ?? '') ?? new Set<string>();
        const acks = redisMockState.sets.get(ackKey ?? '') ?? new Set<string>();
        if (expected.size === 0 || [...expected].some((userId) => !acks.has(userId))) return 0;
        if (redisMockState.strings.has(dispatchKey ?? '')) return 0;
        redisMockState.strings.set(dispatchKey ?? '', '1');
        return 1;
      },
      multi: () => {
        const operations: Array<() => Promise<unknown>> = [];
        const chain = {
          sAdd: (key: string, values: string | string[]) => {
            operations.push(() => client.sAdd(key, values));
            return chain;
          },
          expire: (key: string, seconds: number) => {
            operations.push(() => client.expire(key, seconds));
            return chain;
          },
          exec: async () => Promise.all(operations.map((operation) => operation())),
        };
        return chain;
      },
    };
    return client;
  },
}));

vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  scheduleRealtimeTimer: (...args: unknown[]) => realtimeTimerMocks.schedule(...args),
  cancelRealtimeTimer: (...args: unknown[]) => realtimeTimerMocks.cancel(...args),
}));

vi.mock('../../src/modules/achievements/index.js', () => ({
  achievementsService: {
    evaluateForMatch: (...args: unknown[]) => evaluateAchievementsForMatchMock(...args),
    listUnlockedForMatch: (...args: unknown[]) => listUnlockedForMatchMock(...args),
  },
}));

vi.mock('../../src/realtime/match-cache.js', () => ({
  deleteMatchCache: (...args: unknown[]) => deleteMatchCacheMock(...args),
  commitCachedAnswer: (...args: unknown[]) => commitCachedAnswerMock(...args),
  getMatchCacheOrRebuild: (...args: unknown[]) => getMatchCacheOrRebuildMock(...args),
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...args: unknown[]) => getMatchMock(...args),
    setMatchStatePayload: (...args: unknown[]) => setMatchStatePayloadMock(...args),
    insertMatchAnswerIfMissing: (...args: unknown[]) => insertMatchAnswerIfMissingMock(...args),
    updatePlayerTotals: (...args: unknown[]) => updatePlayerTotalsMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
    updatePlayerAvgTime: (...args: unknown[]) => updatePlayerAvgTimeMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-answers.repo.js', () => ({
  matchAnswersRepo: {
    getAnswerForUser: (...args: unknown[]) => getAnswerForUserMock(...args),
    listAnswersForQuestion: (...args: unknown[]) => listAnswersForQuestionMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-questions.repo.js', () => ({
  matchQuestionsRepo: {
    setQuestionTiming: (...args: unknown[]) => setQuestionTimingMock(...args),
    getMatchQuestion: (...args: unknown[]) => getMatchQuestionMock(...args),
    getRandomQuestionForMatch: vi.fn(),
    insertMatchQuestionIfMissing: vi.fn(),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/matches/matches.service.js')>();
  return {
    ...actual,
    matchesService: {
      ...actual.matchesService,
      buildMatchQuestionPayload: (...args: unknown[]) => buildMatchQuestionPayloadMock(...args),
      computeAvgTimes: (...args: unknown[]) => computeAvgTimesMock(...args),
      completeMatch: (...args: unknown[]) => completeMatchMock(...args),
      // recordPartyQuizAnswerIfMissing moved from matchesRepo to
      // matchesService in Step 5 of the matches.repo split.
      recordPartyQuizAnswerIfMissing: (...args: unknown[]) => recordPartyQuizAnswerIfMissingMock(...args),
    },
  };
});

function createIoMock() {
  const events: Array<{ room: string; event: string; payload: unknown }> = [];
  const io = {
    to(room: string) {
      return {
        emit(event: string, payload?: unknown) {
          events.push({ room, event, payload });
        },
      };
    },
    in() {
      return {
        fetchSockets: async () => [],
      };
    },
  } as unknown as QuizballServer;

  return { io, events };
}

function createSocketMock(userId: string) {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    data: {
      user: { id: userId, role: 'user' },
    },
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
  } as unknown as QuizballSocket;

  return { socket, emitted };
}

describe('party quiz realtime flow', () => {
  let partyState: {
    version: 1;
    variant: 'friendly_party_quiz';
    totalQuestions: number;
    currentQuestion: { qIndex: number } | null;
    answeredUserIds: string[];
    droppedUserIds: string[];
    winnerDecisionMethod: 'total_points' | 'forfeit' | null;
    stateVersionCounter: number;
  };
  let players: Array<{
    user_id: string;
    seat: number;
    total_points: number;
    correct_answers: number;
    goals: number;
    penalty_goals: number;
    avg_time_ms: number | null;
  }>;
  let answers: Array<{
    user_id: string;
    selected_index: number | null;
    is_correct: boolean;
    points_earned: number;
    time_ms: number;
  }>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(acquireLock).mockImplementation(async () => ({ acquired: true, token: 'lock-token' }));
    realtimeTimerMocks.schedule.mockResolvedValue(undefined);
    realtimeTimerMocks.cancel.mockResolvedValue(undefined);

    partyState = {
      version: 1,
      variant: 'friendly_party_quiz',
      totalQuestions: 10,
      currentQuestion: { qIndex: 0 },
      answeredUserIds: [],
      droppedUserIds: [],
      winnerDecisionMethod: null,
      stateVersionCounter: 0,
    };
    redisMockState.pausedMatches.clear();
    redisMockState.open = false;
    redisMockState.failCommands = false;
    redisMockState.sets.clear();
    redisMockState.strings.clear();
    players = [
      { user_id: 'u1', seat: 1, total_points: 120, correct_answers: 1, goals: 0, penalty_goals: 0, avg_time_ms: 2200 },
      { user_id: 'u2', seat: 2, total_points: 90, correct_answers: 1, goals: 0, penalty_goals: 0, avg_time_ms: 2100 },
      { user_id: 'u3', seat: 3, total_points: 60, correct_answers: 0, goals: 0, penalty_goals: 0, avg_time_ms: null },
    ];
    answers = [];

    getMatchMock.mockImplementation(async () => ({
      id: 'match-1',
      mode: 'friendly',
      status: 'active',
      total_questions: 10,
      current_q_index: partyState.currentQuestion?.qIndex ?? 0,
      state_payload: partyState,
      started_at: new Date().toISOString(),
      ended_at: null,
      winner_user_id: null,
      category_a_id: 'cat-1',
    }));
    listMatchPlayersMock.mockImplementation(async () => players.map((player) => ({ ...player })));
    getAnswerForUserMock.mockResolvedValue(null);
    insertMatchAnswerIfMissingMock.mockResolvedValue(true);
    updatePlayerTotalsMock.mockImplementation(async (_matchId: string, userId: string, pointsEarned: number, isCorrect: boolean) => {
      const player = players.find((entry) => entry.user_id === userId);
      if (!player) return null;
      player.total_points += pointsEarned;
      if (isCorrect) player.correct_answers += 1;
      return {
        user_id: userId,
        total_points: player.total_points,
        correct_answers: player.correct_answers,
      };
    });
    recordPartyQuizAnswerIfMissingMock.mockImplementation(async (data: {
      userId: string;
      selectedIndex: number | null;
      isCorrect: boolean;
      timeMs: number;
      pointsEarned: number;
    }) => {
      const existing = answers.find((answer) => answer.user_id === data.userId);
      const player = players.find((entry) => entry.user_id === data.userId) ?? null;
      if (existing) {
        return {
          inserted: false,
          answer: existing,
          player,
        };
      }

      const answer = {
        user_id: data.userId,
        selected_index: data.selectedIndex,
        is_correct: data.isCorrect,
        points_earned: data.pointsEarned,
        time_ms: data.timeMs,
      };
      answers.push(answer);
      if (player) {
        player.total_points += data.pointsEarned;
        if (data.isCorrect) player.correct_answers += 1;
      }

      return {
        inserted: true,
        answer,
        player,
      };
    });
    setMatchStatePayloadMock.mockImplementation(async (_matchId: string, nextState: typeof partyState) => {
      partyState = { ...nextState, answeredUserIds: [...nextState.answeredUserIds] };
    });
    listAnswersForQuestionMock.mockImplementation(async () => answers.map((answer) => ({ ...answer })));
    completeMatchMock.mockResolvedValue(undefined);
    updatePlayerAvgTimeMock.mockResolvedValue(undefined);
    setQuestionTimingMock.mockResolvedValue(undefined);
    getMatchQuestionMock.mockResolvedValue({ correct_index: 2 });
    deleteMatchCacheMock.mockResolvedValue(undefined);
    commitCachedAnswerMock.mockResolvedValue(undefined);
    getMatchCacheOrRebuildMock.mockResolvedValue(null);
    computeAvgTimesMock.mockResolvedValue(new Map());
    evaluateAchievementsForMatchMock.mockResolvedValue({
      u1: [
        {
          id: 'debut_match',
          title: 'Debut Match',
          description: 'Complete your first match.',
          icon: 'Trophy',
          unlocked: true,
          progress: 1,
          target: 1,
          unlockedAt: '2026-03-08T00:00:00.000Z',
        },
      ],
    });
    listUnlockedForMatchMock.mockResolvedValue({
      u1: [
        {
          id: 'debut_match',
          title: 'Debut Match',
          description: 'Complete your first match.',
          icon: 'Trophy',
          unlocked: true,
          progress: 1,
          target: 1,
          unlockedAt: '2026-03-08T00:00:00.000Z',
        },
      ],
    });
    buildMatchQuestionPayloadMock.mockResolvedValue({
      question: {
        kind: 'multipleChoice',
        id: 'question-1',
        prompt: { en: 'Who scored?' },
        options: [
          { id: 'a', text: { en: 'A' }, is_correct: false },
          { id: 'b', text: { en: 'B' }, is_correct: false },
          { id: 'c', text: { en: 'C' }, is_correct: true },
          { id: 'd', text: { en: 'D' }, is_correct: false },
        ],
        categoryId: 'cat-1',
        categoryName: { en: 'Football' },
        difficulty: 'easy',
        explanation: null,
      },
      correctIndex: 2,
      categoryId: 'cat-1',
      phaseKind: 'normal',
      phaseRound: 1,
      shooterSeat: null,
      attackerSeat: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks answered flags and emits party state after an answer', async () => {
    const { handlePartyQuizAnswer } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io, events } = createIoMock();
    const { socket, emitted } = createSocketMock('u1');

    await handlePartyQuizAnswer(io, socket, {
      matchId: 'match-1',
      qIndex: 0,
      selectedIndex: 2,
      timeMs: 1000,
    });

    const ackEvent = emitted.find((entry) => entry.event === 'match:answer_ack');
    expect(ackEvent?.payload).toEqual(expect.objectContaining({
      matchId: 'match-1',
      qIndex: 0,
      selectedIndex: 2,
      isCorrect: true,
      correctIndex: 2,
      myTotalPoints: 220,
      pointsEarned: 100,
    }));

    const partyStateEvent = events.find((entry) => entry.event === 'match:party_state');
    expect(partyStateEvent?.payload).toEqual(expect.objectContaining({
      matchId: 'match-1',
      rankingOrder: ['u1', 'u2', 'u3'],
      players: expect.arrayContaining([
        expect.objectContaining({ userId: 'u1', answered: true }),
        expect.objectContaining({ userId: 'u2', answered: false }),
        expect.objectContaining({ userId: 'u3', answered: false }),
      ]),
    }));
    expect(setMatchStatePayloadMock).not.toHaveBeenCalled();
  });

  it('uses the supplied Redis cache without party answer read round trips', async () => {
    const { handlePartyQuizAnswer } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io, events } = createIoMock();
    const { socket } = createSocketMock('u1');
    const cache = {
      matchId: 'match-1',
      status: 'active',
      mode: 'friendly',
      totalQuestions: 10,
      categoryAId: 'cat-1',
      categoryBId: null,
      startedAt: new Date().toISOString(),
      players: players.map((player) => ({
        userId: player.user_id,
        seat: player.seat,
        totalPoints: player.total_points,
        correctAnswers: player.correct_answers,
        goals: player.goals,
        penaltyGoals: player.penalty_goals,
        avgTimeMs: player.avg_time_ms,
      })),
      currentQIndex: 0,
      statePayload: partyState,
      currentQuestion: null,
      answers: {},
    } as unknown as MatchCache;
    recordPartyQuizAnswerIfMissingMock.mockResolvedValue({
      inserted: true,
      answer: {
        match_id: 'match-1',
        q_index: 0,
        user_id: 'u1',
        selected_index: 2,
        is_correct: true,
        time_ms: 1500,
        points_earned: 85,
        answer_payload: {},
        phase_kind: 'normal',
        phase_round: 1,
        shooter_seat: null,
        answered_at: new Date().toISOString(),
      },
      player: {
        match_id: 'match-1',
        user_id: 'u1',
        seat: 1,
        total_points: 205,
        correct_answers: 2,
        avg_time_ms: 2200,
        goals: 0,
        penalty_goals: 0,
      },
    });
    getMatchCacheOrRebuildMock.mockResolvedValue(cache);

    await handlePartyQuizAnswer(io, socket, {
      matchId: 'match-1',
      qIndex: 0,
      selectedIndex: 2,
      timeMs: 1500,
    }, undefined, cache);

    expect(getMatchMock).not.toHaveBeenCalled();
    expect(listMatchPlayersMock).not.toHaveBeenCalled();
    expect(listAnswersForQuestionMock).not.toHaveBeenCalled();
    expect(commitCachedAnswerMock).toHaveBeenCalledTimes(1);
    expect(events.some((entry) => entry.event === 'match:party_state')).toBe(true);
  });

  it('emits ranking order sorted by points, correctness, then average time when resolving a round', async () => {
    const { resolvePartyQuizRound } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io, events } = createIoMock();

    partyState = {
      ...partyState,
      answeredUserIds: ['u1', 'u2', 'u3'],
      stateVersionCounter: 2,
    };
    players = [
      { user_id: 'u1', seat: 1, total_points: 300, correct_answers: 3, goals: 0, penalty_goals: 0, avg_time_ms: 2500 },
      { user_id: 'u2', seat: 2, total_points: 300, correct_answers: 3, goals: 0, penalty_goals: 0, avg_time_ms: 1800 },
      { user_id: 'u3', seat: 3, total_points: 260, correct_answers: 2, goals: 0, penalty_goals: 0, avg_time_ms: 1600 },
    ];
    answers = [
      { user_id: 'u1', selected_index: 2, is_correct: true, points_earned: 90, time_ms: 1000 },
      { user_id: 'u2', selected_index: 1, is_correct: false, points_earned: 0, time_ms: 4000 },
      { user_id: 'u3', selected_index: 2, is_correct: true, points_earned: 60, time_ms: 3500 },
    ];

    await resolvePartyQuizRound(io, 'match-1', 0);

    expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
      'match-1',
      expect.objectContaining({
        currentQuestion: null,
        answeredUserIds: [],
        stateVersionCounter: 3,
      }),
      1
    );

    const roundResultEvent = events.find((entry) => entry.event === 'match:round_result');
    expect(roundResultEvent?.payload).toEqual(expect.objectContaining({
      matchId: 'match-1',
      qIndex: 0,
      correctIndex: 2,
      rankingOrder: ['u2', 'u1', 'u3'],
    }));

    const partyStateEvent = events.filter((entry) => entry.event === 'match:party_state').at(-1);
    expect(partyStateEvent?.payload).toEqual(expect.objectContaining({
      matchId: 'match-1',
      rankingOrder: ['u2', 'u1', 'u3'],
      leaderUserId: 'u2',
      players: expect.arrayContaining([
        expect.objectContaining({ userId: 'u2', rank: 1, answered: false }),
        expect.objectContaining({ userId: 'u1', rank: 2, answered: false }),
        expect.objectContaining({ userId: 'u3', rank: 3, answered: false }),
      ]),
    }));
    expect(realtimeTimerMocks.schedule).toHaveBeenCalledWith(
      'party_round_transition',
      'match-1:0',
      expect.any(Date),
      {
        kind: 'party_round_transition',
        matchId: 'match-1',
        resolvedQIndex: 0,
        nextQIndex: 1,
      }
    );
  });

  it('durably dispatches a missing next question and cancels the transition timer', async () => {
    const { runPartyQuizRoundTransition } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io, events } = createIoMock();

    partyState = {
      ...partyState,
      currentQuestion: null,
      answeredUserIds: [],
      stateVersionCounter: 3,
    };
    getMatchMock.mockImplementation(async () => ({
      id: 'match-1',
      mode: 'friendly',
      status: 'active',
      total_questions: 10,
      current_q_index: 1,
      state_payload: partyState,
      started_at: new Date().toISOString(),
      ended_at: null,
      winner_user_id: null,
      category_a_id: 'cat-1',
    }));

    const dispatchedAt = Date.now();
    await runPartyQuizRoundTransition(io, 'match-1', 0, 1);

    expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
      'match-1',
      expect.objectContaining({ currentQuestion: { qIndex: 1, correctIndex: 2 } }),
      1
    );
    expect(events.some((entry) => entry.event === 'match:question')).toBe(true);
    const questionTimerCall = realtimeTimerMocks.schedule.mock.calls.find(
      (call) => call[0] === 'party_question' && call[1] === 'match-1:1'
    );
    expect(questionTimerCall?.[2]).toBeInstanceOf(Date);
    expect((questionTimerCall?.[2] as Date).getTime() - dispatchedAt).toBe(13_000);
    expect(realtimeTimerMocks.cancel).toHaveBeenCalledWith(
      'party_round_transition',
      'match-1:0'
    );
  });

  it('keeps the local ready ceiling when durable transition scheduling fails', async () => {
    const {
      resolvePartyQuizRound,
      handlePartyQuizReadyForNextQuestion,
    } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io, events } = createIoMock();
    redisMockState.open = true;
    redisMockState.failCommands = true;
    realtimeTimerMocks.schedule.mockRejectedValueOnce(new Error('redis write failed'));
    partyState = {
      ...partyState,
      answeredUserIds: ['u1', 'u2', 'u3'],
    };
    answers = players.map((player) => ({
      user_id: player.user_id,
      selected_index: 2,
      is_correct: true,
      points_earned: 100,
      time_ms: 1000,
    }));

    await expect(resolvePartyQuizRound(io, 'match-1', 0)).resolves.toBeUndefined();
    getMatchMock.mockImplementation(async () => ({
      id: 'match-1',
      mode: 'friendly',
      status: 'active',
      total_questions: 10,
      current_q_index: 1,
      state_payload: partyState,
      started_at: new Date().toISOString(),
      ended_at: null,
      winner_user_id: null,
      category_a_id: 'cat-1',
    }));

    await vi.advanceTimersByTimeAsync(8_000);
    expect(events.some((entry) => entry.event === 'match:question')).toBe(true);
  });

  it('advances immediately when a shared Redis ready gate receives every ack', async () => {
    const {
      resolvePartyQuizRound,
      handlePartyQuizReadyForNextQuestion,
    } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io, events } = createIoMock();
    redisMockState.open = true;
    partyState = {
      ...partyState,
      answeredUserIds: ['u1', 'u2', 'u3'],
    };
    answers = players.map((player) => ({
      user_id: player.user_id,
      selected_index: 2,
      is_correct: true,
      points_earned: 100,
      time_ms: 1000,
    }));

    await resolvePartyQuizRound(io, 'match-1', 0);
    getMatchMock.mockImplementation(async () => ({
      id: 'match-1',
      mode: 'friendly',
      status: 'active',
      total_questions: 10,
      current_q_index: 1,
      state_payload: partyState,
      started_at: new Date().toISOString(),
      ended_at: null,
      winner_user_id: null,
      category_a_id: 'cat-1',
    }));

    await handlePartyQuizReadyForNextQuestion(io, 'u1', 'match-1', 0);
    await handlePartyQuizReadyForNextQuestion(io, 'u2', 'match-1', 0);
    expect(events.some((entry) => entry.event === 'match:question')).toBe(false);

    await handlePartyQuizReadyForNextQuestion(io, 'u3', 'match-1', 0);
    expect(events.some((entry) => entry.event === 'match:question')).toBe(true);
    expect(realtimeTimerMocks.cancel).toHaveBeenCalledWith(
      'party_round_transition',
      'match-1:0'
    );
  });

  it('advances an empty participant gate without arming a durable timer', async () => {
    const { resolvePartyQuizRound } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io, events } = createIoMock();
    partyState = {
      ...partyState,
      answeredUserIds: [],
      droppedUserIds: players.map((player) => player.user_id),
    };
    answers = [];
    getMatchMock.mockImplementation(async () => ({
      id: 'match-1',
      mode: 'friendly',
      status: 'active',
      total_questions: 10,
      current_q_index: partyState.currentQuestion?.qIndex ?? 1,
      state_payload: partyState,
      started_at: new Date().toISOString(),
      ended_at: null,
      winner_user_id: null,
      category_a_id: 'cat-1',
    }));

    await resolvePartyQuizRound(io, 'match-1', 0);
    await vi.waitFor(() => {
      expect(events.some((entry) => entry.event === 'match:question')).toBe(true);
    });
    expect(realtimeTimerMocks.schedule).not.toHaveBeenCalledWith(
      'party_round_transition',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('rejects a transition when an older question is still active', async () => {
    const { runPartyQuizRoundTransition } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io } = createIoMock();

    await expect(runPartyQuizRoundTransition(io, 'match-1', 0, 1)).rejects.toThrow(
      'found question 0, expected 1'
    );
    expect(realtimeTimerMocks.cancel).not.toHaveBeenCalledWith(
      'party_round_transition',
      'match-1:0'
    );
  });

  it('rejects a transition when the persisted question index is not ready', async () => {
    const { runPartyQuizRoundTransition } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io } = createIoMock();
    partyState = { ...partyState, currentQuestion: null };

    await expect(runPartyQuizRoundTransition(io, 'match-1', 0, 1)).rejects.toThrow(
      'persisted index 0, expected 1'
    );
  });

  it('does not resolve and reveal a party round while the match is paused', async () => {
    const { resolvePartyQuizRound } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io, events } = createIoMock();
    redisMockState.pausedMatches.add('match:pause:match-1');
    answers = [
      { user_id: 'u1', selected_index: 2, is_correct: true, points_earned: 90, time_ms: 1000 },
      { user_id: 'u2', selected_index: 1, is_correct: false, points_earned: 0, time_ms: 4000 },
      { user_id: 'u3', selected_index: 2, is_correct: true, points_earned: 60, time_ms: 3500 },
    ];

    await resolvePartyQuizRound(io, 'match-1', 0, true);

    expect(setMatchStatePayloadMock).not.toHaveBeenCalled();
    expect(events.some((entry) => entry.event === 'match:round_result')).toBe(false);
  });

  it('does not dispatch a party question while the match is paused', async () => {
    const { sendPartyQuizQuestion } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io, events } = createIoMock();
    redisMockState.pausedMatches.add('match:pause:match-1');

    await sendPartyQuizQuestion(io, 'match-1', 1);

    expect(setMatchStatePayloadMock).not.toHaveBeenCalled();
    expect(setQuestionTimingMock).not.toHaveBeenCalled();
    expect(events.some((entry) => entry.event === 'match:question')).toBe(false);
  });

  it('derives answered users from answer rows instead of mutating match state', async () => {
    const { handlePartyQuizAnswer } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io, events } = createIoMock();
    const { socket } = createSocketMock('u3');

    partyState = {
      ...partyState,
      answeredUserIds: ['u1', 'u2'],
      stateVersionCounter: 4,
    };
    answers = [
      { user_id: 'u1', selected_index: 2, is_correct: true, points_earned: 90, time_ms: 1000 },
      { user_id: 'u2', selected_index: 1, is_correct: false, points_earned: 0, time_ms: 4000 },
    ];

    await handlePartyQuizAnswer(io, socket, {
      matchId: 'match-1',
      qIndex: 0,
      selectedIndex: 2,
      timeMs: 1500,
    });

    expect(setMatchStatePayloadMock).not.toHaveBeenCalledWith(
      'match-1',
      expect.objectContaining({
        answeredUserIds: ['u1', 'u2', 'u3'],
      }),
      0
    );
    expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
      'match-1',
      expect.objectContaining({
        currentQuestion: null,
        answeredUserIds: [],
      }),
      1
    );
    const partyStateEvent = events.find((entry) => entry.event === 'match:party_state');
    expect(partyStateEvent?.payload).toEqual(expect.objectContaining({
      players: expect.arrayContaining([
        expect.objectContaining({ userId: 'u1', answered: true }),
        expect.objectContaining({ userId: 'u2', answered: true }),
        expect.objectContaining({ userId: 'u3', answered: true }),
      ]),
    }));
  });

  it('handles duplicate submits without double-scoring and still emits party state', async () => {
    const { handlePartyQuizAnswer } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io, events } = createIoMock();
    const { socket, emitted } = createSocketMock('u1');

    answers = [
      { user_id: 'u1', selected_index: 2, is_correct: true, points_earned: 100, time_ms: 1000 },
    ];

    await handlePartyQuizAnswer(io, socket, {
      matchId: 'match-1',
      qIndex: 0,
      selectedIndex: 2,
      timeMs: 1000,
    });

    expect(recordPartyQuizAnswerIfMissingMock).toHaveBeenCalledTimes(1);
    expect(players.find((player) => player.user_id === 'u1')?.total_points).toBe(120);
    expect(emitted).toContainEqual({
      event: 'match:answer_ack',
      payload: expect.objectContaining({
        isCorrect: true,
        myTotalPoints: 120,
        pointsEarned: 100,
      }),
    });
    expect(events.some((entry) => entry.event === 'match:party_state')).toBe(true);
    expect(setMatchStatePayloadMock).not.toHaveBeenCalled();
  });

  it('idempotently acknowledges a duplicate answer after the round advanced', async () => {
    const { handlePartyQuizAnswer } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io } = createIoMock();
    const { socket, emitted } = createSocketMock('u1');
    partyState = { ...partyState, currentQuestion: { qIndex: 1 } };
    getAnswerForUserMock.mockResolvedValue({
      user_id: 'u1',
      selected_index: 2,
      is_correct: true,
      points_earned: 100,
      time_ms: 1000,
    });

    await handlePartyQuizAnswer(io, socket, {
      matchId: 'match-1',
      qIndex: 0,
      selectedIndex: 2,
      timeMs: 1000,
    });

    expect(emitted).toContainEqual({
      event: 'match:answer_ack',
      payload: expect.objectContaining({
        matchId: 'match-1',
        qIndex: 0,
        selectedIndex: 2,
        isCorrect: true,
        correctIndex: 2,
        myTotalPoints: 120,
      }),
    });
    expect(emitted.some((entry) => entry.event === 'error')).toBe(false);
    expect(recordPartyQuizAnswerIfMissingMock).not.toHaveBeenCalled();
  });

  it('handles six concurrent party answers without losing answered state', async () => {
    const { handlePartyQuizAnswer } = await import('../../src/realtime/party-quiz-match-flow.js');
    const { io, events } = createIoMock();
    let roundLockGranted = false;
    vi.mocked(acquireLock).mockImplementation(async (key: string) => {
      if (key.includes(':round:')) {
        if (roundLockGranted) return { acquired: false };
        roundLockGranted = true;
      }
      return { acquired: true, token: 'lock-token' };
    });

    players = Array.from({ length: 6 }, (_, index) => ({
      user_id: `u${index + 1}`,
      seat: index + 1,
      total_points: 0,
      correct_answers: 0,
      goals: 0,
      penalty_goals: 0,
      avg_time_ms: null,
    }));

    await Promise.all(players.map((player, index) => {
      const { socket } = createSocketMock(player.user_id);
      return handlePartyQuizAnswer(io, socket, {
        matchId: 'match-1',
        qIndex: 0,
        selectedIndex: 2,
        timeMs: 1000 + index,
      });
    }));

    expect(answers).toHaveLength(6);
    expect(players.every((player) => player.total_points > 0 && player.correct_answers === 1)).toBe(true);

    const allAnsweredPartyState = events
      .filter((entry) => entry.event === 'match:party_state')
      .find((entry) => {
        const payload = entry.payload as { players?: Array<{ answered: boolean }> };
        return payload.players?.length === 6 && payload.players.every((player) => player.answered);
      });
    expect(allAnsweredPartyState).toBeDefined();

    const roundResults = events.filter((entry) => entry.event === 'match:round_result');
    expect(roundResults).toHaveLength(1);
  });
});
