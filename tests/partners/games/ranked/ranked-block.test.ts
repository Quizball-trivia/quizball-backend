import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../setup.js';

// A Freecroco player blocked during a running match has left (contract §5.5 + §7.1). When the opponent had already
// dropped out (in its disconnect grace, or left during ours), both dropped: the score decides, never a forfeit win.

const entryMock = vi.fn();
const getMatchMock = vi.fn();
const presenceMock = vi.fn();
const forfeitMock = vi.fn();
const progressMock = vi.fn();
const abandonMock = vi.fn();

vi.mock('../../../../src/db/index.js', () => ({ sql: vi.fn() }));
const workMock = vi.fn();
const ageMock = vi.fn();
const releaseMock = vi.fn();
const cleanupMock = vi.fn();
const sessionState = vi.hoisted(() => ({ cleaned: false, search: {} as Record<string, string> }));
vi.mock('../../../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({
    isOpen: true,
    exists: async () => 0,
    hGet: async () => 'search-1',
    hGetAll: async () => sessionState.search,
  }),
}));
vi.mock('../../../../src/modules/partners/games/ranked/ranked-entries.js', () => ({
  getOpenPartnerRankedEntryForPlay: (...a: unknown[]) => entryMock(...a),
  listPartnerRankedReconcileWork: (...a: unknown[]) => workMock(...a),
  reconcilePartnerRankedMatch: vi.fn(),
  releasePartnerRankedSearch: (...a: unknown[]) => releaseMock(...a),
  partnerRankedSearchAge: (...a: unknown[]) => ageMock(...a),
}));
vi.mock('../../../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: { getMatch: (...a: unknown[]) => getMatchMock(...a) },
}));
vi.mock('../../../../src/realtime/services/match-participants.helpers.js', () => ({
  getParticipantSnapshot: vi.fn(async () => ({
    participants: [{ user_id: 'blocked', seat: 1 }, { user_id: 'opponent', seat: 2 }],
    cache: null,
  })),
}));
vi.mock('../../../../src/realtime/services/match-presence.service.js', () => ({
  resolveMatchPresence: (...a: unknown[]) => presenceMock(...a),
}));
vi.mock('../../../../src/realtime/services/match-forfeit.service.js', () => ({
  finalizeMatchAsForfeit: (...a: unknown[]) => forfeitMock(...a),
  buildOpponentForfeitPendingPayload: vi.fn(() => ({})),
}));
vi.mock('../../../../src/realtime/possession-completion.js', () => ({
  completePossessionMatchFromProgress: (...a: unknown[]) => progressMock(...a),
}));
vi.mock('../../../../src/realtime/services/match-disconnect.service.js', () => ({
  abandonPossessionTerminalMatch: (...a: unknown[]) => abandonMock(...a),
}));
vi.mock('../../../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalResultsPayload: vi.fn(async () => null),
  emitFinalResultsToMatchParticipants: vi.fn(),
}));
vi.mock('../../../../src/realtime/match-flow.js', () => ({ cancelMatchQuestionTimer: vi.fn() }));
vi.mock('../../../../src/realtime/possession-match-flow.js', () => ({ cancelPossessionHalftimeTimer: vi.fn() }));
vi.mock('../../../../src/realtime/services/user-session-guard.service.js', () => {
  const state = () => ({ state: sessionState.cleaned ? 'IDLE' : 'IN_QUEUE', activeMatchId: null });
  return {
    userSessionGuardService: {
      withUserSessionLock: async (_userId: string, work: () => Promise<unknown>) => work(),
      cleanupRankedQueueArtifacts: async (...a: unknown[]) => {
        sessionState.cleaned = true;
        return cleanupMock(...a);
      },
      resolveState: async () => state(),
      resolveStates: async (userIds: string[]) => new Map(userIds.map((u) => [u, state()])),
    },
  };
});

const { registerPartnerRankedBlockHandler, reconcilePartnerRanked } = await import('../../../../src/modules/partners/games/ranked/ranked-realtime.js');
const { emitPartnerPlayerBlocked } = await import('../../../../src/modules/partners/partner-events.js');

const liveSocket = { data: { partner: { sessionId: 'fresh' } }, emit: vi.fn(), disconnect: vi.fn() };
const io = {
  in: vi.fn(() => ({ fetchSockets: async () => [liveSocket] })),
  to: vi.fn(() => ({ emit: vi.fn() })),
} as never;
registerPartnerRankedBlockHandler(io);
const block = () => emitPartnerPlayerBlocked({
  slug: 'freecroco', environment: 'test', playerId: 'p', externalPlayerId: 'x', userId: 'blocked',
  revokedSessionIds: ['s1'], cancelledPlayIds: ['play1'],
});
const state = (opponentPresent: boolean, exitPending: string[] = []) => ({
  absentPlayers: opponentPresent ? [{ user_id: 'blocked' }] : [{ user_id: 'blocked' }, { user_id: 'opponent' }],
  presentPlayers: opponentPresent ? [{ user_id: 'opponent' }] : [],
  exitPendingUserIds: exitPending,
});

describe('partner block during a running match', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    entryMock.mockResolvedValue({ userId: 'blocked', state: 'playing', matchId: 'm1' });
    getMatchMock.mockResolvedValue({ id: 'm1', status: 'active', current_q_index: 6 });
    forfeitMock.mockResolvedValue({ completed: true, resultVersion: 1 });
    progressMock.mockResolvedValue({ completed: true });
  });

  it('opponent connected: the blocked player is the leaver (forfeit)', async () => {
    presenceMock.mockResolvedValue(state(true));
    await block();
    expect(forfeitMock).toHaveBeenCalledWith(expect.objectContaining({ forfeitingUserId: 'blocked' }));
    expect(progressMock).not.toHaveBeenCalled();
  });

  it('opponent already disconnected: both dropped, decided by the score', async () => {
    presenceMock.mockResolvedValue(state(false));
    await block();
    expect(forfeitMock).not.toHaveBeenCalled();
    expect(progressMock).toHaveBeenCalledWith(io, 'm1', 'partner_block_opponent_dropped', { kind: 'both_dropped' });
  });

  it('opponent left during the grace (excused exit): both dropped; level → abandoned (plays back, none for the blocked)', async () => {
    presenceMock.mockResolvedValue(state(true, ['opponent']));
    progressMock.mockResolvedValue({ completed: false, reason: 'undecidable' });
    await block();
    expect(forfeitMock).not.toHaveBeenCalled();
    expect(abandonMock).toHaveBeenCalledOnce();
  });

  it('the reconciler ends the blocked play\'s match without closing a session opened since', async () => {
    presenceMock.mockResolvedValue(state(true));
    workMock.mockResolvedValue({ endedMatchIds: [], staleSearches: [], blockedInActiveMatch: [{ userId: 'blocked', playId: 'play1' }] });
    await reconcilePartnerRanked(io);
    expect(entryMock).toHaveBeenCalledWith('play1');
    expect(forfeitMock).toHaveBeenCalledWith(expect.objectContaining({ forfeitingUserId: 'blocked' }));
    expect(liveSocket.disconnect).not.toHaveBeenCalled();
  });
});

describe('partner reconciler: a stuck search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.cleaned = false;
    releaseMock.mockResolvedValue(true);
    ageMock.mockResolvedValue(700);
    workMock.mockResolvedValue({
      endedMatchIds: [], blockedInActiveMatch: [], staleSearches: [{ userId: 'u', playId: 'old', staleSeconds: 700 }],
    });
  });

  it('is torn down only when the queued Redis search is that play\'s and itself stuck (not a fresh retry)', async () => {
    sessionState.search = { userId: 'u', status: 'queued', playId: 'new' };
    await reconcilePartnerRanked(io);
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();

    sessionState.search = { userId: 'u', status: 'queued', playId: 'old', queuedAt: String(Date.now()) };
    await reconcilePartnerRanked(io);
    expect(cleanupMock).not.toHaveBeenCalled();

    sessionState.search = { userId: 'u', status: 'queued', playId: 'old', queuedAt: String(Date.now() - 700_000) };
    await reconcilePartnerRanked(io);
    expect(cleanupMock).toHaveBeenCalledOnce();
    expect(releaseMock).toHaveBeenCalledWith('u', 'reconciler_stuck_search', 'old');
  });

  it('is judged on its entry as it is now: seen alive since the scan, it is left alone', async () => {
    sessionState.search = { userId: 'u', status: 'queued', playId: 'old' };
    ageMock.mockResolvedValue(5);
    await reconcilePartnerRanked(io);
    expect(ageMock).toHaveBeenCalledWith('old');
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });
});
