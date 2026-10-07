import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../setup.js';

// The ranked play reconciler: one replica at a time (a renewed lock), no new work once that lock is lost, and one
// batched state read for the stale searches.

const workMock = vi.fn();
const reconcileMatchMock = vi.fn();
const releaseSearchMock = vi.fn();
const acquireMock = vi.fn();
const extendMock = vi.fn();
const releaseLockMock = vi.fn();
const resolveStateMock = vi.fn();
const resolveStatesMock = vi.fn();

vi.mock('../../../../src/db/index.js', () => ({ sql: vi.fn() }));
vi.mock('../../../../src/modules/partners/games/ranked/ranked-entries.js', () => ({
  getOpenPartnerRankedEntryForPlay: vi.fn(),
  listPartnerRankedReconcileWork: (...a: unknown[]) => workMock(...a),
  partnerRankedSearchAge: async () => 40,
  reconcilePartnerRankedMatch: (...a: unknown[]) => reconcileMatchMock(...a),
  releasePartnerRankedSearch: (...a: unknown[]) => releaseSearchMock(...a),
}));
vi.mock('../../../../src/realtime/locks.js', () => ({
  acquireLock: (...a: unknown[]) => acquireMock(...a),
  extendLock: (...a: unknown[]) => extendMock(...a),
  releaseLock: (...a: unknown[]) => releaseLockMock(...a),
}));
vi.mock('../../../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({ isOpen: true, exists: async () => 0, hGet: async () => null }),
}));
vi.mock('../../../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    resolveState: (...a: unknown[]) => resolveStateMock(...a),
    resolveStates: (...a: unknown[]) => resolveStatesMock(...a),
    withUserSessionLock: async (_userId: string, work: () => Promise<unknown>) => work(),
    cleanupRankedQueueArtifacts: vi.fn(),
  },
}));
vi.mock('../../../../src/modules/matches/matches.repo.js', () => ({ matchesRepo: { getMatch: vi.fn() } }));
vi.mock('../../../../src/realtime/services/match-participants.helpers.js', () => ({ getParticipantSnapshot: vi.fn() }));
vi.mock('../../../../src/realtime/services/match-presence.service.js', () => ({ resolveMatchPresence: vi.fn() }));
vi.mock('../../../../src/realtime/services/match-forfeit.service.js', () => ({
  finalizeMatchAsForfeit: vi.fn(),
  buildOpponentForfeitPendingPayload: vi.fn(),
}));
vi.mock('../../../../src/realtime/possession-completion.js', () => ({ completePossessionMatchFromProgress: vi.fn() }));
vi.mock('../../../../src/realtime/services/match-disconnect.service.js', () => ({ abandonPossessionTerminalMatch: vi.fn() }));
vi.mock('../../../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalResultsPayload: vi.fn(),
  emitFinalResultsToMatchParticipants: vi.fn(),
}));
vi.mock('../../../../src/realtime/match-flow.js', () => ({ cancelMatchQuestionTimer: vi.fn() }));
vi.mock('../../../../src/realtime/possession-match-flow.js', () => ({ cancelPossessionHalftimeTimer: vi.fn() }));

const { reconcilePartnerRanked, startPartnerRankedReconciler, stopPartnerRankedReconciler } = await import(
  '../../../../src/modules/partners/games/ranked/ranked-realtime.js'
);

const io = {} as never;
const idle = { state: 'IDLE', activeMatchId: null };
const busy = { state: 'IN_LOBBY', activeMatchId: null };

describe('partner ranked reconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workMock.mockResolvedValue({ endedMatchIds: [], blockedInActiveMatch: [], staleSearches: [] });
    reconcileMatchMock.mockResolvedValue(true);
    releaseSearchMock.mockResolvedValue(true);
    resolveStateMock.mockResolvedValue(idle);
  });
  afterEach(async () => {
    await stopPartnerRankedReconciler();
    vi.useRealTimers();
  });

  it('claims nothing more once told to stop', async () => {
    workMock.mockResolvedValue({ endedMatchIds: ['m1', 'm2', 'm3'], blockedInActiveMatch: [], staleSearches: [{ userId: 'u1', playId: 'p1', staleSeconds: 40 }] });
    let calls = 0;
    const result = await reconcilePartnerRanked(io, () => (calls += 1) <= 2);
    expect(reconcileMatchMock).toHaveBeenCalledTimes(1);
    expect(resolveStatesMock).not.toHaveBeenCalled();
    expect(releaseSearchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ matches: 1, searches: 0 });
  });

  it('reads the stale searchers\' states in one batch and re-checks only a player it releases', async () => {
    workMock.mockResolvedValue({
      endedMatchIds: [],
      blockedInActiveMatch: [],
      staleSearches: [{ userId: 'idle', playId: 'p-idle', staleSeconds: 40 }, { userId: 'busy', playId: 'p-busy', staleSeconds: 40 }],
    });
    resolveStatesMock.mockResolvedValue(new Map([['idle', idle], ['busy', busy]]));
    const result = await reconcilePartnerRanked(io);
    expect(resolveStatesMock).toHaveBeenCalledOnce();
    expect(resolveStatesMock).toHaveBeenCalledWith(['idle', 'busy']);
    expect(resolveStateMock.mock.calls).toEqual([['idle']]);
    expect(releaseSearchMock).toHaveBeenCalledWith('idle', 'reconciler_idle_search', 'p-idle');
    expect(result).toEqual({ matches: 0, searches: 1 });
  });

  it('a player busy in the batch but idle on the fresh re-check is not released from the batch alone', async () => {
    workMock.mockResolvedValue({ endedMatchIds: [], blockedInActiveMatch: [], staleSearches: [{ userId: 'u', playId: 'p', staleSeconds: 40 }] });
    resolveStatesMock.mockResolvedValue(new Map([['u', idle]]));
    resolveStateMock.mockResolvedValue(busy);
    expect(await reconcilePartnerRanked(io)).toEqual({ matches: 0, searches: 0 });
    expect(releaseSearchMock).not.toHaveBeenCalled();
  });

  it('renews its lock while it works and stops claiming work once a renewal fails', async () => {
    vi.useFakeTimers();
    acquireMock.mockResolvedValue({ acquired: true, token: 'tok' });
    extendMock.mockResolvedValue(false);
    let finishFirst!: () => void;
    reconcileMatchMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishFirst = () => resolve(true);
    }));
    workMock.mockResolvedValue({ endedMatchIds: ['m1', 'm2'], blockedInActiveMatch: [], staleSearches: [] });

    startPartnerRankedReconciler(io);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(acquireMock).toHaveBeenCalledWith('partner:ranked:reconcile', 15_000);
    expect(reconcileMatchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(extendMock).toHaveBeenCalledWith('partner:ranked:reconcile', 'tok', 15_000);
    finishFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileMatchMock).toHaveBeenCalledTimes(1);
    expect(releaseLockMock).toHaveBeenCalledWith('partner:ranked:reconcile', 'tok');
  });

  it('keeps renewing through a long item, then stops claiming once the tick budget is spent', async () => {
    vi.useFakeTimers();
    acquireMock.mockResolvedValue({ acquired: true, token: 'tok' });
    extendMock.mockResolvedValue(true);
    let finishFirst!: () => void;
    reconcileMatchMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishFirst = () => resolve(true);
    }));
    workMock.mockResolvedValue({ endedMatchIds: ['m1', 'm2'], blockedInActiveMatch: [], staleSearches: [] });

    startPartnerRankedReconciler(io);
    await vi.advanceTimersByTimeAsync(15_000);
    // Twice the lock's lifetime on one item: the lock is kept, never left to expire under it.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(extendMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(releaseLockMock).not.toHaveBeenCalled();
    finishFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileMatchMock).toHaveBeenCalledTimes(1);
    expect(releaseLockMock).toHaveBeenCalledWith('partner:ranked:reconcile', 'tok');
  });
});
