import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchRow } from '../../src/modules/matches/matches.types.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

import '../setup.js';

const getMatchMock = vi.fn();
const getActiveMatchForUserMock = vi.fn();
const setMatchStatePayloadMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const getParticipantSnapshotMock = vi.fn();
const getOpponentInfoMock = vi.fn();
const getByIdsMock = vi.fn();
const hasAnyStagePresenceMock = vi.fn();
const completeFromProgressMock = vi.fn();
const finalizeForfeitMock = vi.fn();
const scheduleRealtimeTimerMock = vi.fn();
const deferPossessionQuestionTimerForPauseMock = vi.fn();
const cancelPossessionHalftimeTimerMock = vi.fn();
const emitStateMock = vi.fn();
const runWithUserTransitionLockMock = vi.fn();

const redisValues = new Map<string, string>();
const fakeRedis = {
  isOpen: true,
  set: vi.fn(async (key: string, value: string, options?: { NX?: boolean }) => {
    if (options?.NX && redisValues.has(key)) return null;
    redisValues.set(key, value);
    return 'OK';
  }),
  get: vi.fn(async (key: string) => redisValues.get(key) ?? null),
  incr: vi.fn(async (key: string) => {
    const next = Number(redisValues.get(key) ?? '0') + 1;
    redisValues.set(key, String(next));
    return next;
  }),
  expire: vi.fn(async () => true),
  mGet: vi.fn(async (keys: string[]) => keys.map((key) => redisValues.get(key) ?? null)),
  del: vi.fn(async (keys: string | string[]) => {
    const keyList = Array.isArray(keys) ? keys : [keys];
    let deleted = 0;
    for (const key of keyList) {
      if (redisValues.delete(key)) deleted += 1;
    }
    return deleted;
  }),
  exists: vi.fn(async (key: string) => (redisValues.has(key) ? 1 : 0)),
  ttl: vi.fn(async () => -1),
};

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/core/metrics.js', () => ({
  appMetrics: {
    matchPauses: { add: vi.fn() },
  },
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => fakeRedis,
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...args: unknown[]) => getMatchMock(...args),
    getActiveMatchForUser: (...args: unknown[]) => getActiveMatchForUserMock(...args),
    setMatchStatePayload: (...args: unknown[]) => setMatchStatePayloadMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
  },
}));

vi.mock('../../src/modules/matches/match-questions.repo.js', () => ({
  matchQuestionsRepo: {},
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getByIds: (...args: unknown[]) => getByIdsMock(...args),
  },
}));

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: { refundRankedTickets: vi.fn() },
}));

vi.mock('../../src/realtime/session-country.js', () => ({
  getCurrentCountriesForUsers: vi.fn(async () => new Map()),
}));

vi.mock('../../src/realtime/match-cache.js', () => ({
  getMatchCache: vi.fn(async () => null),
}));

vi.mock('../../src/realtime/match-flow.js', () => ({
  cancelMatchQuestionTimer: vi.fn(),
  sendMatchQuestion: vi.fn(),
}));

vi.mock('../../src/realtime/possession-match-flow.js', () => ({
  cancelPossessionHalftimeTimer: (...args: unknown[]) => cancelPossessionHalftimeTimerMock(...args),
  deferPossessionQuestionTimerForPause: (...args: unknown[]) =>
    deferPossessionQuestionTimerForPauseMock(...args),
  emitPossessionStateToSocket: vi.fn(),
  ensurePossessionActiveTimers: vi.fn(async () => true),
  fireAndForget: vi.fn(),
  resumePossessionHalftimeAfterPause: vi.fn(),
  resumePossessionMatchQuestion: vi.fn(async () => false),
}));

vi.mock('../../src/realtime/possession-completion.js', () => ({
  completePossessionMatchFromProgress: (...args: unknown[]) => completeFromProgressMock(...args),
}));

vi.mock('../../src/realtime/party-quiz-match-flow.js', () => ({
  emitPartyQuizStateToSocket: vi.fn(),
  ensurePartyQuizActiveTimer: vi.fn(),
  resumePartyQuizQuestion: vi.fn(async () => false),
  sendPartyQuizQuestion: vi.fn(),
}));

vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  cancelRealtimeTimer: vi.fn(),
  scheduleRealtimeTimer: (...args: unknown[]) => scheduleRealtimeTimerMock(...args),
}));

vi.mock('../../src/realtime/match-ui-ready-gate.js', () => ({
  acknowledgeMatchUiReady: vi.fn(),
  emitMatchUiReadyGateStateToSocket: vi.fn(),
  openMatchUiReadyGate: vi.fn(),
}));

vi.mock('../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalResultsPayload: vi.fn(async () => null),
  emitFinalResultsToMatchParticipants: vi.fn(),
}));

vi.mock('../../src/realtime/services/match-forfeit.service.js', () => ({
  buildOpponentForfeitPendingPayload: vi.fn(() => ({ type: 'opponent' })),
  buildReconnectLimitForfeitPendingPayload: vi.fn(() => ({ type: 'limit' })),
  finalizeMatchAsForfeit: (...args: unknown[]) => finalizeForfeitMock(...args),
  isRankedEarlyForfeitMatch: vi.fn(() => false),
  setForfeitPendingForUser: vi.fn(),
}));

vi.mock('../../src/realtime/services/party-quiz-dropout.service.js', () => ({
  applyPartyQuizDropouts: vi.fn(),
  buildPartyDropoutPayload: vi.fn(() => ({})),
  setPartyDropoutPendingForUser: vi.fn(),
}));

vi.mock('../../src/realtime/services/match-participants.helpers.js', () => ({
  buildParticipantPayloads: vi.fn(() => []),
  getOpponentInfo: (...args: unknown[]) => getOpponentInfoMock(...args),
  getOpponentInfoFromParticipants: vi.fn(() => null),
  getParticipantSnapshot: (...args: unknown[]) => getParticipantSnapshotMock(...args),
  resolveMatchCategoryName: vi.fn(() => null),
}));

vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    emitState: (...args: unknown[]) => emitStateMock(...args),
    runWithUserTransitionLock: (...args: unknown[]) => runWithUserTransitionLockMock(...args),
  },
}));

vi.mock('../../src/realtime/services/match-excused-exit.service.js', () => ({
  findOpponentInDisconnectGrace: vi.fn(async () => null),
  markExcusedExitPending: vi.fn(),
}));

vi.mock('../../src/realtime/services/match-stage-presence.service.js', () => ({
  hasAnyMatchStagePresenceFromSocketIds: (...args: unknown[]) => hasAnyStagePresenceMock(...args),
}));

function createMatch(overrides: Partial<MatchRow> = {}): MatchRow {
  return {
    id: 'm1',
    mode: 'ranked',
    status: 'active',
    current_q_index: 5,
    total_questions: 12,
    state_payload: { variant: 'ranked_sim', phase: 'NORMAL_PLAY' },
    ...overrides,
  } as MatchRow;
}

function player(userId: string, seat: number) {
  return {
    match_id: 'm1',
    user_id: userId,
    seat,
    total_points: 0,
    correct_answers: 0,
    avg_time_ms: null,
    goals: 0,
    penalty_goals: 0,
  };
}

function userMap(ids: string[]): Map<string, { id: string; nickname: string; avatar_url: null; is_ai: boolean }> {
  return new Map(ids.map((id) => [id, { id, nickname: id, avatar_url: null, is_ai: id.startsWith('ai-') }]));
}

function createSocket(
  userId: string,
  matchId = 'm1',
  connectedAt = Date.now() - 10_000,
  socketId = `socket-${userId}`
): QuizballSocket {
  return {
    id: socketId,
    data: {
      user: { id: userId, role: 'user' },
      matchId,
      connectedAt,
    },
    emit: vi.fn(),
    leave: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
  } as unknown as QuizballSocket;
}

function createIo(matchSockets: QuizballSocket[] = []): QuizballServer {
  const emit = vi.fn();
  return {
    to: vi.fn(() => ({ emit })),
    in: vi.fn((room: string) => ({
      fetchSockets: vi.fn(async () => (room === 'match:m1' ? matchSockets : [])),
      socketsJoin: vi.fn(async () => undefined),
    })),
  } as unknown as QuizballServer;
}

function hasSocketId(params: unknown, socketId: string): boolean {
  const socketIds = (params as { socketIds?: unknown }).socketIds;
  return Array.isArray(socketIds) && socketIds.includes(socketId);
}


/**
 * INC-2026-07-29 / recurrence 2026-07-30: a read-only database pool must never
 * cost a player their reconnect budget or hand them a forfeit.
 */
describe('pauseMatchForDisconnectedPlayer during a database write outage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    redisValues.clear();
    fakeRedis.isOpen = true;
    const { readOnlyDbBreaker } = await import('../../src/db/readonly-breaker.js');
    readOnlyDbBreaker.resetForTests();
    const roster = [player('u1', 1), player('u2', 2)];
    getMatchMock.mockResolvedValue(createMatch());
    getActiveMatchForUserMock.mockResolvedValue(createMatch());
    listMatchPlayersMock.mockResolvedValue(roster);
    getParticipantSnapshotMock.mockResolvedValue({ participants: roster, cache: null });
    getOpponentInfoMock.mockResolvedValue({ userId: 'u2', username: 'u2' });
    getByIdsMock.mockImplementation(async (ids: string[]) => userMap(ids));
    completeFromProgressMock.mockResolvedValue({ completed: true, winnerId: 'u1', decisionBasis: 'total_points' });
    finalizeForfeitMock.mockResolvedValue({ completed: true, winnerId: 'u2', resultVersion: 1 });
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
    hasAnyStagePresenceMock.mockResolvedValue(false);
  });

  afterEach(async () => {
    const { readOnlyDbBreaker } = await import('../../src/db/readonly-breaker.js');
    readOnlyDbBreaker.resetForTests();
  });

  async function tripBreaker(): Promise<void> {
    const { readOnlyDbBreaker } = await import('../../src/db/readonly-breaker.js');
    const error = new Error('cannot execute INSERT in a read-only transaction') as Error & { code: string };
    error.code = '25006';
    readOnlyDbBreaker.recordError(error);
    expect(readOnlyDbBreaker.snapshot().degraded).toBe(true);
  }

  it('does NOT increment the disconnect counter while degraded', async () => {
    const { pauseMatchForDisconnectedPlayer } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );
    await tripBreaker();
    redisValues.set('match:reconnect_count:m1:u1', '1');

    const result = await pauseMatchForDisconnectedPlayer(createIo(), 'm1', 'u1', {
      ignoreSocketId: 'old-socket',
      disconnectedConnectedAt: Date.now() - 60_000,
    });

    // The budget is frozen: the count is unchanged and the player keeps their
    // remaining reconnects.
    expect(redisValues.get('match:reconnect_count:m1:u1')).toBe('1');
    expect(fakeRedis.incr).not.toHaveBeenCalled();
    // MAX_MATCH_DISCONNECTS is 3, so a frozen count of 1 leaves 2 reconnects.
    expect(result.remainingReconnects).toBe(2);
    expect(finalizeForfeitMock).not.toHaveBeenCalled();
  });

  it('suppresses the reconnect-limit forfeit fast path while degraded', async () => {
    const { pauseMatchForDisconnectedPlayer } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );
    await tripBreaker();
    // Already over the limit — without the gate this forfeits via
    // definiteForfeiterUserId, which bypasses every presence guard.
    redisValues.set('match:reconnect_count:m1:u1', '5');

    const result = await pauseMatchForDisconnectedPlayer(createIo(), 'm1', 'u1', {
      ignoreSocketId: 'old-socket',
      disconnectedConnectedAt: Date.now() - 60_000,
    });

    expect(result.finalized).toBe(false);
    expect(finalizeForfeitMock).not.toHaveBeenCalled();
    expect(completeFromProgressMock).not.toHaveBeenCalled();
  });

  it('still increments and still forfeits once the outage clears', async () => {
    const { pauseMatchForDisconnectedPlayer } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );
    const { readOnlyDbBreaker } = await import('../../src/db/readonly-breaker.js');
    // Never tripped: normal behaviour must be untouched by this change.
    expect(readOnlyDbBreaker.snapshot().degraded).toBe(false);
    redisValues.set('match:reconnect_count:m1:u1', '3');

    const result = await pauseMatchForDisconnectedPlayer(createIo(), 'm1', 'u1', {
      ignoreSocketId: 'old-socket',
      disconnectedConnectedAt: Date.now() - 60_000,
    });

    // 3 -> 4 exceeds MAX_MATCH_DISCONNECTS, so the forfeit path runs as before.
    expect(redisValues.get('match:reconnect_count:m1:u1')).toBe('4');
    expect(result.finalized).toBe(true);
  });

  it('defers grace-window expiry by THROWING so the durable timer is re-armed', async () => {
    const { resolveExpiredGraceWindow } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );
    const { DbWriteOutageDeferral } = await import('../../src/db/readonly-breaker.js');
    await tripBreaker();
    redisValues.set('match:disconnect:m1:u1', String(Date.now()));
    redisValues.set('match:grace:m1', String(Date.now()));

    // Must THROW, not return: the scheduler has already popped the ZSET member,
    // so a clean return would mark the timer handled and delete its payload —
    // losing the only thing that can ever resolve this paused match.
    await expect(resolveExpiredGraceWindow(createIo(), 'm1', 'u1')).rejects.toThrow(
      DbWriteOutageDeferral
    );

    expect(finalizeForfeitMock).not.toHaveBeenCalled();
    expect(completeFromProgressMock).not.toHaveBeenCalled();
    // The pause survives so the re-armed expiry can resolve it once writes recover.
    expect(redisValues.get('match:grace:m1')).toBeDefined();
    expect(redisValues.get('match:disconnect:m1:u1')).toBeDefined();
  });
});
