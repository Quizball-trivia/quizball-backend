/**
 * Terminal-notification coverage for the DELAYED ranked-AI callbacks
 * (match-found timer, draft-start timer). Before be#426 these paths could
 * strand the searcher on an endless spinner: compensation cleaned up the
 * lobby/bot but nothing was ever emitted to the human player.
 *
 * The io mock records the destination room per emit so the tests prove WHO
 * received each event, not just that it was emitted somewhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../setup.js';

const usersRepo = {
  findTakenLowerNicknames: vi.fn().mockResolvedValue(new Set<string>()),
  getById: vi.fn().mockResolvedValue({ id: 'human', country: 'GE', is_ai: false }),
  create: vi.fn(),
};
const lobbiesRepo = {
  createLobby: vi.fn(),
  addMember: vi.fn().mockResolvedValue(undefined),
  updateRankedContext: vi.fn().mockResolvedValue(undefined),
  removeMember: vi.fn().mockResolvedValue(undefined),
  deleteLobby: vi.fn().mockResolvedValue(undefined),
  getById: vi.fn(),
  listMembersWithUser: vi.fn(),
  listOpenLobbiesForUser: vi.fn().mockResolvedValue([]),
};
const reservationService = {
  isEnabled: vi.fn().mockReturnValue(true),
  acquire: vi.fn(),
  releaseOwned: vi.fn().mockResolvedValue(undefined),
  abortLobby: vi.fn().mockResolvedValue({ aborted: true, botReleased: 'bot-1', lobbyDeleted: true, removedMemberIds: [] }),
};
const selectionService = {
  selectAndReserve: vi.fn(),
  recordRecentlyFaced: vi.fn().mockResolvedValue(undefined),
};
const sessionGuard = {
  emitState: vi.fn().mockResolvedValue(undefined),
  resolveState: vi.fn(),
};
const startDraftMock = vi.fn();
const trackRankedQueueLeftMock = vi.fn();

vi.mock('../../src/modules/users/users.repo.js', () => ({ usersRepo }));
vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo }));
vi.mock('../../src/modules/synthetic-bots/reservation.service.js', () => ({ reservationService }));
vi.mock('../../src/modules/synthetic-bots/synthetic-bot-selection.service.js', () => ({
  syntheticBotSelectionService: selectionService,
}));
vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: {
    ensureProfile: vi.fn().mockResolvedValue({ user_id: 'human', rp: 1500, placement_status: 'placed', placement_played: 3, placement_required: 3, placement_wins: 2 }),
    buildAiMatchContext: vi.fn().mockReturnValue({ isPlacement: false, aiAnchorRp: 1500, aiCorrectness: 0.5, aiDelayProfile: { minMs: 500, maxMs: 3000 } }),
    buildPersistentBotMatchContext: vi.fn().mockReturnValue({ aiCorrectness: 0.5, aiDelayProfile: { minMs: 500, maxMs: 3000 } }),
    DEFAULT_AI_OPPONENT_RP: 1900,
  },
}));
vi.mock('../../src/core/analytics.js', () => ({ registerAiUserId: vi.fn() }));
vi.mock('../../src/core/analytics/game-events.js', () => ({
  trackRankedMatchFound: vi.fn(),
  trackRankedQueueLeft: (...args: unknown[]) => trackRankedQueueLeftMock(...args),
}));
vi.mock('../../src/modules/stats/stats.service.js', () => ({ statsService: { getRecentFormForUser: vi.fn().mockResolvedValue([]) } }));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));
vi.mock('../../src/realtime/lobby-utils.js', () => ({
  attachUserSocketsToLobby: vi.fn().mockResolvedValue(undefined),
  emitLobbyState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: sessionGuard,
}));
vi.mock('../../src/realtime/services/lobby-draft-start.service.js', () => ({
  startDraft: (...args: unknown[]) => startDraftMock(...args),
}));
vi.mock('../../src/core/rng.js', () => ({ getRandom: () => 0.5 }));
vi.mock('../../src/core/harness-timing.js', () => ({ harnessDelayMs: (n: number) => n }));

type RoomEvent = { room: string; event: string; payload?: unknown };
const roomEvents: RoomEvent[] = [];
const io = {
  to: (room: string) => ({
    emit: (event: string, payload?: unknown) => {
      roomEvents.push({ room, event, payload });
    },
  }),
  in: () => ({ fetchSockets: vi.fn().mockResolvedValue([]) }),
} as never;

const { startRankedAiForUser } = await import('../../src/realtime/services/lobby-ranked-ai.service.js');

const SEARCH_MS = 1000;
const FOUND_MODAL_MS = 1200;
const LOCK_RETRY_MS = 3500;

const CLEAR_SNAPSHOT = { state: 'IDLE', activeMatchId: null, waitingLobbyId: null, queueSearchId: null };
const WAITING_LOBBY = { id: 'lobby-1', mode: 'ranked', status: 'waiting', host_user_id: 'human' };
const BOT = {
  user_id: 'bot-1',
  nickname: 'Beka',
  avatar_url: null,
  rp: 1800,
  country: 'GE',
  home_city: 'Tbilisi',
  home_lat: 41.7,
  home_lng: 44.8,
  favorite_club: 'FCB',
};

function terminalAborts(room: string): RoomEvent[] {
  return roomEvents.filter(
    (e) =>
      e.room === room &&
      (e.event === 'ranked:queue_left' ||
        (e.event === 'error' && (e.payload as { code?: string } | undefined)?.code === 'MATCH_PREPARATION_FAILED'))
  );
}

async function runSearchPhase(): Promise<void> {
  const started = await startRankedAiForUser(io, 'human', { skipSearchEmit: true, searchDurationMs: SEARCH_MS });
  expect(started).toBe(true);
  await vi.advanceTimersByTimeAsync(SEARCH_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  roomEvents.length = 0;
  reservationService.isEnabled.mockReturnValue(true);
  reservationService.abortLobby.mockResolvedValue({ aborted: true, botReleased: 'bot-1', lobbyDeleted: true, removedMemberIds: [] });
  selectionService.selectAndReserve.mockResolvedValue({ bot: BOT, reservation: { botUserId: 'bot-1', fence: 'f1' } });
  lobbiesRepo.createLobby.mockResolvedValue({ id: 'lobby-1' });
  lobbiesRepo.getById.mockResolvedValue(WAITING_LOBBY);
  lobbiesRepo.listMembersWithUser.mockResolvedValue([
    { user_id: 'human' },
    { user_id: 'bot-1' },
  ]);
  lobbiesRepo.listOpenLobbiesForUser.mockResolvedValue([]);
  sessionGuard.resolveState.mockResolvedValue(CLEAR_SNAPSHOT);
  sessionGuard.emitState.mockResolvedValue(undefined);
  startDraftMock.mockResolvedValue('started');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handleRankedAiMatchFound failure notification', () => {
  it('notifies the searcher when the match-found callback throws (DB rejection)', async () => {
    lobbiesRepo.getById.mockRejectedValue(new Error('db down'));

    await runSearchPhase();

    expect(reservationService.abortLobby).toHaveBeenCalledWith('lobby-1', 'match_found_cancel', undefined);
    const aborts = terminalAborts('user:human');
    expect(aborts.some((e) => e.event === 'ranked:queue_left')).toBe(true);
    const err = aborts.find((e) => e.event === 'error');
    expect((err?.payload as { meta: { source: string } }).meta.source).toBe('ranked_ai_match_found_error');
    expect(trackRankedQueueLeftMock).toHaveBeenCalledWith(expect.objectContaining({ source: 'server_abort' }));
    expect(sessionGuard.emitState).toHaveBeenCalledWith(io, 'human');
  });

  it('notifies the searcher when the lobby vanished before match-found', async () => {
    lobbiesRepo.getById.mockResolvedValue(null);

    await runSearchPhase();

    const err = terminalAborts('user:human').find((e) => e.event === 'error');
    expect((err?.payload as { meta: { source: string } }).meta.source).toBe('ranked_ai_match_found_lobby_missing');
  });

  it('notifies the searcher when lobby membership was torn down underneath', async () => {
    lobbiesRepo.listMembersWithUser.mockResolvedValue([{ user_id: 'human' }]);

    await runSearchPhase();

    const err = terminalAborts('user:human').find((e) => e.event === 'error');
    expect((err?.payload as { meta: { source: string } }).meta.source).toBe('ranked_ai_match_found_membership_missing');
  });

  it('stays silent when the lobby advanced elsewhere (another actor owns it)', async () => {
    lobbiesRepo.getById.mockResolvedValue({ ...WAITING_LOBBY, status: 'active' });

    await runSearchPhase();

    expect(terminalAborts('user:human')).toHaveLength(0);
    expect(reservationService.abortLobby).not.toHaveBeenCalled();
  });

  it('stays silent when a superseding session owns the user', async () => {
    sessionGuard.resolveState.mockResolvedValue({ ...CLEAR_SNAPSHOT, activeMatchId: 'm-live' });

    await runSearchPhase();

    expect(terminalAborts('user:human')).toHaveLength(0);
  });

  it('protects a NEW queue search: re-emits state instead of queue_left', async () => {
    lobbiesRepo.getById.mockResolvedValue(null);
    sessionGuard.resolveState.mockResolvedValue({ ...CLEAR_SNAPSHOT, queueSearchId: 's-new' });

    await runSearchPhase();

    expect(terminalAborts('user:human')).toHaveLength(0);
    expect(sessionGuard.emitState).toHaveBeenCalledWith(io, 'human');
  });

  it('suppresses the terminal abort when compensation no-oped because THIS lobby committed (waitingLobbyId === lobbyId)', async () => {
    // A reconnect activated this very lobby's draft; the locked abort no-ops
    // and the session snapshot reports the committed lobby in waitingLobbyId.
    lobbiesRepo.listMembersWithUser.mockRejectedValue(new Error('transient'));
    reservationService.abortLobby.mockResolvedValue({ aborted: false, botReleased: null, lobbyDeleted: false, removedMemberIds: [] });
    sessionGuard.resolveState.mockResolvedValue({ ...CLEAR_SNAPSHOT, waitingLobbyId: 'lobby-1' });

    await runSearchPhase();

    expect(terminalAborts('user:human')).toHaveLength(0);
    expect(sessionGuard.emitState).toHaveBeenCalledWith(io, 'human');
  });

  it('still notifies when compensation itself FAILED and only OUR stale lobby survives', async () => {
    // The abort errored (DB hiccup): the waiting lobby survives as ours, not
    // because a committed draft won. Suppressing here would strand the
    // pre-found spinner with no watchdog armed.
    lobbiesRepo.listMembersWithUser.mockRejectedValue(new Error('transient'));
    reservationService.abortLobby.mockResolvedValue({ aborted: false, botReleased: null, lobbyDeleted: false, removedMemberIds: [], failed: true });
    sessionGuard.resolveState.mockResolvedValue({ ...CLEAR_SNAPSHOT, waitingLobbyId: 'lobby-1' });

    await runSearchPhase();

    const aborts = terminalAborts('user:human');
    expect(aborts.some((e) => e.event === 'ranked:queue_left')).toBe(true);
  });

  it('failed compensation still defers to a DIFFERENT live lobby in the snapshot', async () => {
    lobbiesRepo.listMembersWithUser.mockRejectedValue(new Error('transient'));
    reservationService.abortLobby.mockResolvedValue({ aborted: false, botReleased: null, lobbyDeleted: false, removedMemberIds: [], failed: true });
    sessionGuard.resolveState.mockResolvedValue({ ...CLEAR_SNAPSHOT, waitingLobbyId: 'lobby-other' });

    await runSearchPhase();

    expect(terminalAborts('user:human')).toHaveLength(0);
    expect(sessionGuard.emitState).toHaveBeenCalledWith(io, 'human');
  });

  it('suppresses the terminal abort on CORRUPT_MULTI_STATE (a live lobby may hide behind the primary)', async () => {
    lobbiesRepo.getById.mockResolvedValue(null);
    sessionGuard.resolveState.mockResolvedValue({ ...CLEAR_SNAPSHOT, state: 'CORRUPT_MULTI_STATE' });

    await runSearchPhase();

    expect(terminalAborts('user:human')).toHaveLength(0);
    expect(sessionGuard.emitState).toHaveBeenCalledWith(io, 'human');
  });

  it('fails open to the terminal events when the state read itself fails', async () => {
    lobbiesRepo.getById.mockResolvedValue(null);
    sessionGuard.resolveState.mockRejectedValue(new Error('state read down'));

    await runSearchPhase();

    expect(terminalAborts('user:human').some((e) => e.event === 'ranked:queue_left')).toBe(true);
  });

  it('emits match_found and schedules the draft on the happy path (no terminal events)', async () => {
    await runSearchPhase();
    await vi.advanceTimersByTimeAsync(FOUND_MODAL_MS);

    expect(roomEvents.some((e) => e.room === 'user:human' && e.event === 'ranked:match_found')).toBe(true);
    expect(startDraftMock).toHaveBeenCalledTimes(1);
    expect(terminalAborts('user:human')).toHaveLength(0);
  });
});

describe('startRankedAiDraft failure notification', () => {
  it('notifies when the lobby vanished before draft start', async () => {
    await runSearchPhase();
    lobbiesRepo.getById.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(FOUND_MODAL_MS);

    const err = terminalAborts('user:human').find((e) => e.event === 'error');
    expect((err?.payload as { meta: { source: string } }).meta.source).toBe('ranked_ai_draft_start_lobby_missing');
    expect(startDraftMock).not.toHaveBeenCalled();
  });

  it('passes expectWaiting so startDraft enforces the waiting status under the lock', async () => {
    await runSearchPhase();
    await vi.advanceTimersByTimeAsync(FOUND_MODAL_MS);

    expect(startDraftMock).toHaveBeenCalledWith(io, 'lobby-1', { expectWaiting: true });
  });

  it('retries on lock contention (delay > lock TTL) and stays silent when the retry succeeds', async () => {
    startDraftMock.mockResolvedValueOnce('lock_busy').mockResolvedValueOnce('started');

    await runSearchPhase();
    await vi.advanceTimersByTimeAsync(FOUND_MODAL_MS);
    expect(startDraftMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LOCK_RETRY_MS);

    expect(startDraftMock).toHaveBeenCalledTimes(2);
    expect(terminalAborts('user:human')).toHaveLength(0);
    expect(reservationService.abortLobby).not.toHaveBeenCalled();
  });

  it('NEVER compensates or notifies on persistent lock contention (live holder owns the lobby)', async () => {
    startDraftMock.mockResolvedValue('lock_busy');

    await runSearchPhase();
    await vi.advanceTimersByTimeAsync(FOUND_MODAL_MS);
    await vi.advanceTimersByTimeAsync(LOCK_RETRY_MS);
    await vi.advanceTimersByTimeAsync(LOCK_RETRY_MS);
    await vi.advanceTimersByTimeAsync(LOCK_RETRY_MS);

    expect(startDraftMock).toHaveBeenCalledTimes(3);
    expect(reservationService.abortLobby).not.toHaveBeenCalled();
    expect(terminalAborts('user:human')).toHaveLength(0);
  });

  it('stays silent when the draft was already committed by a competitor (already_active)', async () => {
    startDraftMock.mockResolvedValue('already_active');

    await runSearchPhase();
    await vi.advanceTimersByTimeAsync(FOUND_MODAL_MS);

    expect(reservationService.abortLobby).not.toHaveBeenCalled();
    expect(terminalAborts('user:human')).toHaveLength(0);
  });

  it('notifies when startDraft reports the lobby missing', async () => {
    startDraftMock.mockResolvedValue('lobby_missing');

    await runSearchPhase();
    await vi.advanceTimersByTimeAsync(FOUND_MODAL_MS);

    const err = terminalAborts('user:human').find((e) => e.event === 'error');
    expect((err?.payload as { meta: { source: string } }).meta.source).toBe('ranked_ai_draft_start_lobby_missing');
  });

  it('notifies with the guarded helper when startDraft throws', async () => {
    startDraftMock.mockRejectedValue(new Error('draft blew up'));

    await runSearchPhase();
    await vi.advanceTimersByTimeAsync(FOUND_MODAL_MS);

    expect(reservationService.abortLobby).toHaveBeenCalledWith('lobby-1', 'draft_start_error', { draftTeardown: true });
    const aborts = terminalAborts('user:human');
    expect(aborts.some((e) => e.event === 'ranked:queue_left')).toBe(true);
    const err = aborts.find((e) => e.event === 'error');
    expect((err?.payload as { meta: { source: string } }).meta.source).toBe('ranked_ai_draft_start');
    expect(sessionGuard.emitState).toHaveBeenCalledWith(io, 'human');
  });

  it('suppresses the terminal abort when a live match superseded the draft failure', async () => {
    startDraftMock.mockRejectedValue(new Error('draft blew up'));

    await runSearchPhase();
    sessionGuard.resolveState.mockResolvedValue({ ...CLEAR_SNAPSHOT, activeMatchId: 'm-live' });
    await vi.advanceTimersByTimeAsync(FOUND_MODAL_MS);

    expect(terminalAborts('user:human')).toHaveLength(0);
    expect(sessionGuard.emitState).toHaveBeenCalledWith(io, 'human');
  });
});
