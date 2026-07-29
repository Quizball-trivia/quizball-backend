/**
 * PR12 challenge semantics for bot targets (§1.12).
 *
 * PR3's behaviour — reject a bot-targeted challenge instantly at send time — was
 * itself a tell: no human target ever fails in zero milliseconds. PR12 replaces
 * it for PERSISTENT bots with an organic response: the invite is created
 * normally and the delayed decline worker answers it (or lets the 5-minute TTL
 * lazy-expire it) like a real friend would.
 *
 * What must NOT change, and is asserted hardest here:
 *   - ZERO ACCEPTS. No path may accept a challenge whose TARGET is `is_ai`.
 *     The friendly-possession engine has no bot driver, so an accepted invite
 *     would strand a human in a lobby whose opponent can never ready up.
 *   - No classification oracle: a non-friend gets NOT_FRIENDS for bots and
 *     humans alike, so an arbitrary UUID cannot be probed for bot-ness.
 *   - Ephemeral/auction bots stay unchallengeable — they present publicly as
 *     AI and are drained by cleanup, so a pending invite against one is dead
 *     weight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

// The first `await import(lobby-challenge.service)` in this file pulls in the
// whole socket-server module graph, which on a cold transform cache regularly
// exceeds vitest's 5s default and times out whichever test happens to run
// first. That cost is module loading, not test work — and it already made the
// pre-existing PR3 version of this file flaky. Raise the per-test budget here
// rather than let an environment-dependent timeout masquerade as a failure.
vi.setConfig({ testTimeout: 30_000 });

import { config } from '../../src/core/config.js';

const configObj = config as unknown as { PERSISTENT_BOTS_ENABLED: boolean };

const getByIdMock = vi.fn();
const friendshipExistsMock = vi.fn();
const resolveStateMock = vi.fn();
const runWithUserTransitionLockMock = vi.fn();
const getInvitationByIdMock = vi.fn();
const updateInvitationStatusMock = vi.fn();
const expireStalePendingBetweenMock = vi.fn();
const findPendingBetweenMock = vi.fn();
const joinByCodeMock = vi.fn();
const getLobbyByIdMock = vi.fn();

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: { getById: (...args: unknown[]) => getByIdMock(...args) },
  isUserAccountInactive: (user: { is_deleted?: boolean; deleted_at?: string | null; pending_deletion_at?: string | null }) =>
    Boolean(user.is_deleted || user.deleted_at || user.pending_deletion_at),
}));

vi.mock('../../src/modules/friends/friends.repo.js', () => ({
  friendsRepo: { friendshipExists: (...args: unknown[]) => friendshipExistsMock(...args) },
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: { getById: (...args: unknown[]) => getLobbyByIdMock(...args) },
}));

vi.mock('../../src/modules/lobbies/lobby-challenge-invitations.repo.js', () => ({
  lobbyChallengeInvitationsRepo: {
    // Must be explicitly resolved: a bare vi.fn() returns undefined, and the
    // persistent-bot path now runs PAST the old early-return into these calls,
    // so an unresolved promise would hang the test to its timeout.
    expireStalePendingBetween: (...args: unknown[]) => expireStalePendingBetweenMock(...args),
    findPendingBetween: (...args: unknown[]) => findPendingBetweenMock(...args),
    getById: (...args: unknown[]) => getInvitationByIdMock(...args),
    updateStatus: (...args: unknown[]) => updateInvitationStatusMock(...args),
  },
}));

vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    resolveState: (...args: unknown[]) => resolveStateMock(...args),
    runWithUserTransitionLock: (...args: unknown[]) => runWithUserTransitionLockMock(...args),
    prepareForLobbyEntry: vi.fn(),
    emitBlocked: vi.fn(),
    emitState: vi.fn(),
  },
}));

vi.mock('../../src/realtime/services/lobby-commands.service.js', () => ({
  joinByCode: (...args: unknown[]) => joinByCodeMock(...args),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeSocket(userId: string) {
  const emit = vi.fn();
  return { socket: { data: { user: { id: userId } }, emit, join: vi.fn() } as never, emit };
}

function makeIo() {
  const emit = vi.fn();
  return { io: { to: vi.fn(() => ({ emit })) } as never, emit };
}

describe('challengeFriend — persistent bots are challengeable (PR12)', () => {
  const originalFlag = configObj.PERSISTENT_BOTS_ENABLED;

  afterEach(() => {
    configObj.PERSISTENT_BOTS_ENABLED = originalFlag;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Persistent bots are only challengeable while the flag is on — with it off
    // there is no decline worker to answer the invite, so the send-time
    // rejection stands. Asserted directly in the flag-off block below.
    configObj.PERSISTENT_BOTS_ENABLED = true;
    // A no-op transition lock: the callback never runs, so the test stops right
    // after the guards without doing real lobby work. Enough to prove which
    // guard did (or did not) fire.
    runWithUserTransitionLockMock.mockResolvedValue(false);
    expireStalePendingBetweenMock.mockResolvedValue(undefined);
    findPendingBetweenMock.mockResolvedValue(null);
  });

  it('does NOT reject a befriended persistent-bot target', async () => {
    getByIdMock.mockResolvedValue({ id: 'bot-1', is_ai: true, ai_kind: 'persistent' });
    friendshipExistsMock.mockResolvedValue(true);

    const { challengeFriend } = await import('../../src/realtime/services/lobby-challenge.service.js');
    const { socket, emit } = makeSocket('human-1');

    await challengeFriend({} as never, socket, { toUserId: 'bot-1' });

    expect(emit).not.toHaveBeenCalledWith('error', expect.objectContaining({
      code: 'LOBBY_CHALLENGE_INVALID',
    }));
    // Presence stays AI for bots: the busy probe must be skipped entirely,
    // never asked about a user that can never hold a session.
    expect(resolveStateMock).not.toHaveBeenCalled();
    // It got as far as the real lobby-creation path.
    expect(runWithUserTransitionLockMock).toHaveBeenCalled();
  });

  it('answers NOT_FRIENDS for a non-friend bot target — no bot-classification oracle', async () => {
    getByIdMock.mockResolvedValue({ id: 'bot-2', is_ai: true, ai_kind: 'persistent' });
    friendshipExistsMock.mockResolvedValue(false);

    const { challengeFriend } = await import('../../src/realtime/services/lobby-challenge.service.js');
    const { socket, emit } = makeSocket('human-1');

    await challengeFriend({} as never, socket, { toUserId: 'bot-2' });

    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'LOBBY_CHALLENGE_NOT_FRIENDS' }));
    expect(emit).not.toHaveBeenCalledWith('error', expect.objectContaining({ code: 'LOBBY_CHALLENGE_INVALID' }));
  });

  it('still rejects a befriended EPHEMERAL-bot target', async () => {
    getByIdMock.mockResolvedValue({ id: 'bot-3', is_ai: true, ai_kind: 'ephemeral' });
    friendshipExistsMock.mockResolvedValue(true);

    const { challengeFriend } = await import('../../src/realtime/services/lobby-challenge.service.js');
    const { socket, emit } = makeSocket('human-1');

    await challengeFriend({} as never, socket, { toUserId: 'bot-3' });

    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'LOBBY_CHALLENGE_INVALID' }));
    expect(runWithUserTransitionLockMock).not.toHaveBeenCalled();
  });

  it('still rejects a befriended AUCTION-bot target', async () => {
    getByIdMock.mockResolvedValue({ id: 'bot-4', is_ai: true, ai_kind: 'auction' });
    friendshipExistsMock.mockResolvedValue(true);

    const { challengeFriend } = await import('../../src/realtime/services/lobby-challenge.service.js');
    const { socket, emit } = makeSocket('human-1');

    await challengeFriend({} as never, socket, { toUserId: 'bot-4' });

    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'LOBBY_CHALLENGE_INVALID' }));
  });

  it('lets a human target proceed to the busy probe', async () => {
    getByIdMock.mockResolvedValue({ id: 'human-2', is_ai: false, ai_kind: null });
    friendshipExistsMock.mockResolvedValue(true);
    resolveStateMock.mockResolvedValue({ activeMatchId: null, waitingLobbyId: null, queueSearchId: null, openLobbyIds: [] });

    const { challengeFriend } = await import('../../src/realtime/services/lobby-challenge.service.js');
    const { socket } = makeSocket('human-1');

    await challengeFriend({} as never, socket, { toUserId: 'human-2' });

    // Humans DO get the presence check — the bot skip must not leak to them.
    expect(resolveStateMock).toHaveBeenCalledWith('human-2');
  });
});

describe('challengeFriend — flag-off falls back to the PR3 rejection', () => {
  const originalFlag = configObj.PERSISTENT_BOTS_ENABLED;

  afterEach(() => {
    configObj.PERSISTENT_BOTS_ENABLED = originalFlag;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    configObj.PERSISTENT_BOTS_ENABLED = false;
    runWithUserTransitionLockMock.mockResolvedValue(false);
    expireStalePendingBetweenMock.mockResolvedValue(undefined);
    findPendingBetweenMock.mockResolvedValue(null);
  });

  it('rejects a persistent-bot challenge when the decline worker is disabled', async () => {
    // Without the worker running, an accepted-through invite would hang pending
    // for the full 5-minute TTL with nothing able to answer it — strictly worse
    // for the challenger than the instant rejection. Flag off ⇒ reject.
    getByIdMock.mockResolvedValue({ id: 'bot-1', is_ai: true, ai_kind: 'persistent' });
    friendshipExistsMock.mockResolvedValue(true);

    const { challengeFriend } = await import('../../src/realtime/services/lobby-challenge.service.js');
    const { socket, emit } = makeSocket('human-1');

    await challengeFriend({} as never, socket, { toUserId: 'bot-1' });

    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({
      code: 'LOBBY_CHALLENGE_INVALID',
      message: 'This player is unavailable',
    }));
    // No lobby is created and no invite row is written with the flag off.
    expect(runWithUserTransitionLockMock).not.toHaveBeenCalled();
  });
});

describe('acceptChallenge — ZERO ACCEPTS for an is_ai target (hard invariant)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    expireStalePendingBetweenMock.mockResolvedValue(undefined);
    findPendingBetweenMock.mockResolvedValue(null);
    updateInvitationStatusMock.mockResolvedValue(null);
  });

  // Every AI population, asserted individually: the guard keys on `is_ai`, not
  // on ai_kind, so a future ai_kind added to the enum is refused by default
  // rather than silently becoming acceptable.
  for (const aiKind of ['persistent', 'ephemeral', 'auction', 'some_future_kind']) {
    it(`refuses to accept a challenge targeting an is_ai '${aiKind}' user`, async () => {
      getInvitationByIdMock.mockResolvedValue({
        id: 'invite-1',
        lobby_id: 'lobby-1',
        from_user_id: 'human-1',
        to_user_id: 'bot-1',
        status: 'pending',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      getByIdMock.mockResolvedValue({ id: 'bot-1', is_ai: true, ai_kind: aiKind });

      const { acceptChallenge } = await import('../../src/realtime/services/lobby-challenge.service.js');
      const { socket, emit } = makeSocket('bot-1');
      const { io } = makeIo();

      await acceptChallenge(io, socket, { invitationId: 'invite-1' });

      expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({
        code: 'LOBBY_CHALLENGE_INVALID',
      }));
      // The writes that would constitute an accept must never happen.
      expect(joinByCodeMock).not.toHaveBeenCalled();
      expect(updateInvitationStatusMock).not.toHaveBeenCalled();
    });
  }

  it('refuses when the invite target no longer exists', async () => {
    getInvitationByIdMock.mockResolvedValue({
      id: 'invite-2',
      lobby_id: 'lobby-1',
      from_user_id: 'human-1',
      to_user_id: 'ghost',
      status: 'pending',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    getByIdMock.mockResolvedValue(null);

    const { acceptChallenge } = await import('../../src/realtime/services/lobby-challenge.service.js');
    const { socket, emit } = makeSocket('ghost');
    const { io } = makeIo();

    await acceptChallenge(io, socket, { invitationId: 'invite-2' });

    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'LOBBY_CHALLENGE_INVALID' }));
    expect(joinByCodeMock).not.toHaveBeenCalled();
  });

  it('does not announce an accept the database refused', async () => {
    // updateStatus is a CAS that also refuses is_ai targets, so it can return
    // null. Emitting 'accepted' regardless would tell the challenger a match is
    // starting when no write happened — and with the SQL bot guard in place
    // that is a reachable path, not just a settle race.
    getInvitationByIdMock.mockResolvedValue({
      id: 'invite-4',
      lobby_id: 'lobby-1',
      from_user_id: 'human-1',
      to_user_id: 'human-2',
      status: 'pending',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    getByIdMock.mockResolvedValue({ id: 'human-2', is_ai: false, ai_kind: null });
    getLobbyByIdMock.mockResolvedValue({ id: 'lobby-1', invite_code: 'ABC123', status: 'waiting' });
    joinByCodeMock.mockImplementation(async (_io: unknown, socket: { data: { lobbyId?: string } }) => {
      socket.data.lobbyId = 'lobby-1';
    });
    // The CAS loses — another replica settled it first.
    updateInvitationStatusMock.mockResolvedValue(null);

    const { acceptChallenge } = await import('../../src/realtime/services/lobby-challenge.service.js');
    const { socket, emit } = makeSocket('human-2');
    const { io, emit: ioEmit } = makeIo();

    await acceptChallenge(io, socket, { invitationId: 'invite-4' });

    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({
      code: 'LOBBY_CHALLENGE_NOT_PENDING',
    }));
    expect(ioEmit).not.toHaveBeenCalledWith(
      'lobby:challenge_status',
      expect.objectContaining({ status: 'accepted' })
    );
  });

  it('still lets a HUMAN target accept — the guard must not block real players', async () => {
    getInvitationByIdMock.mockResolvedValue({
      id: 'invite-3',
      lobby_id: 'lobby-1',
      from_user_id: 'human-1',
      to_user_id: 'human-2',
      status: 'pending',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    getByIdMock.mockResolvedValue({ id: 'human-2', is_ai: false, ai_kind: null });
    getLobbyByIdMock.mockResolvedValue({ id: 'lobby-1', invite_code: 'ABC123', status: 'waiting' });
    updateInvitationStatusMock.mockResolvedValue({ id: 'invite-3', status: 'accepted' });
    // joinByCode is what parks the socket in the lobby; emulate success.
    joinByCodeMock.mockImplementation(async (_io: unknown, socket: { data: { lobbyId?: string } }) => {
      socket.data.lobbyId = 'lobby-1';
    });

    const { acceptChallenge } = await import('../../src/realtime/services/lobby-challenge.service.js');
    const { socket } = makeSocket('human-2');
    const { io } = makeIo();

    await acceptChallenge(io, socket, { invitationId: 'invite-3' });

    expect(joinByCodeMock).toHaveBeenCalled();
    expect(updateInvitationStatusMock).toHaveBeenCalledWith('invite-3', 'accepted');
  });
});
