import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchRow } from '../../src/modules/matches/matches.types.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

import '../setup.js';

// completeResumeCountdown deletes the pause key and then asks the possession
// resume path to replay the live question with shifted timing. Only when that
// path refuses does it fall through to a FRESH dispatch (reset timing, cleared
// answers) — so a successful resume must never be followed by sendMatchQuestion.

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

const sendMatchQuestionMock = vi.fn();
const resumePossessionMatchQuestionMock = vi.fn();
const getMatchQuestionMock = vi.fn();
const getMatchCacheOrRebuildMock = vi.fn();

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
  matchQuestionsRepo: { getMatchQuestion: (...args: unknown[]) => getMatchQuestionMock(...args) },
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
  getMatchCacheOrRebuild: (...args: unknown[]) => getMatchCacheOrRebuildMock(...args),
}));

vi.mock('../../src/realtime/match-flow.js', () => ({
  cancelMatchQuestionTimer: vi.fn(),
  sendMatchQuestion: (...args: unknown[]) => sendMatchQuestionMock(...args),
}));

vi.mock('../../src/realtime/possession-match-flow.js', () => ({
  cancelPossessionHalftimeTimer: (...args: unknown[]) => cancelPossessionHalftimeTimerMock(...args),
  deferPossessionQuestionTimerForPause: (...args: unknown[]) =>
    deferPossessionQuestionTimerForPauseMock(...args),
  emitPossessionStateToSocket: vi.fn(),
  ensurePossessionActiveTimers: vi.fn(async () => true),
  fireAndForget: vi.fn(),
  resumePossessionHalftimeAfterPause: vi.fn(),
  resumePossessionMatchQuestion: (...args: unknown[]) => resumePossessionMatchQuestionMock(...args),
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

function createIo() {
  const emit = vi.fn();
  return { io: { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer, emit };
}

describe('completeResumeCountdown → possession resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisValues.clear();
    redisValues.set('match:resume_countdown:m1', '1');
    redisValues.set('match:pause:m1', String(Date.now() - 5_000));
    getMatchMock.mockResolvedValue(createMatch());
    listMatchPlayersMock.mockResolvedValue([
      { match_id: 'm1', user_id: 'u1', seat: 1 },
      { match_id: 'm1', user_id: 'u2', seat: 2 },
    ]);
    getMatchQuestionMock.mockResolvedValue({ match_id: 'm1', q_index: 5 });
    getMatchCacheOrRebuildMock.mockResolvedValue({ currentQIndex: 5, currentQuestion: { qIndex: 5 } });
  });

  it('a successful resume (shifted acks persisted) emits match:resume and NEVER re-dispatches the question', async () => {
    resumePossessionMatchQuestionMock.mockResolvedValue(true);
    const { io, emit } = createIo();
    const pauseStartedAtMs = Date.now() - 5_000;

    const { completeResumeCountdown } = await import('../../src/realtime/services/match-disconnect.service.js');
    await completeResumeCountdown(io, 'm1', pauseStartedAtMs);

    expect(resumePossessionMatchQuestionMock).toHaveBeenCalledWith(io, 'm1', 5, pauseStartedAtMs);
    expect(emit).toHaveBeenCalledWith('match:resume', { matchId: 'm1', nextQIndex: 5 });
    expect(sendMatchQuestionMock).not.toHaveBeenCalled();
    // The pause is gone: a resumed question must not be re-paused by a stale key.
    expect(redisValues.has('match:pause:m1')).toBe(false);
  });

  it('only a refused resume falls through to the fresh dispatch (documented last resort)', async () => {
    resumePossessionMatchQuestionMock.mockResolvedValue(false);
    getMatchCacheOrRebuildMock.mockResolvedValue({ currentQIndex: 5, currentQuestion: null });
    const { io, emit } = createIo();

    const { completeResumeCountdown } = await import('../../src/realtime/services/match-disconnect.service.js');
    await completeResumeCountdown(io, 'm1', Date.now() - 5_000);

    expect(emit).toHaveBeenCalledWith('match:resume', { matchId: 'm1', nextQIndex: 5 });
    expect(sendMatchQuestionMock).toHaveBeenCalledWith(io, 'm1', 5);
  });
});
