/**
 * PR3 guard: a bot target (any kind, incl. a befriended persistent bot) is never
 * challengeable. The friendly-challenge worker (PR12) has no bot support yet and
 * nothing may accept on a bot's behalf (§1.12), so challengeFriend rejects early
 * with the generic "unavailable" error the FE already renders — before the
 * friendship / busy / duplicate checks even run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const getByIdMock = vi.fn();
const friendshipExistsMock = vi.fn();

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: { getById: (...args: unknown[]) => getByIdMock(...args) },
  isUserAccountInactive: (user: { is_deleted?: boolean; deleted_at?: string | null; pending_deletion_at?: string | null }) =>
    Boolean(user.is_deleted || user.deleted_at || user.pending_deletion_at),
}));

vi.mock('../../src/modules/friends/friends.repo.js', () => ({
  friendsRepo: { friendshipExists: (...args: unknown[]) => friendshipExistsMock(...args) },
}));

// The bot guard returns before any of these are reached; mock them so importing
// the module (which pulls in the socket server graph) stays cheap and no real
// session/lobby work can run if the guard ever regresses.
vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo: {} }));
vi.mock('../../src/modules/lobbies/lobby-challenge-invitations.repo.js', () => ({
  lobbyChallengeInvitationsRepo: {
    expireStalePendingBetween: vi.fn(),
    findPendingBetween: vi.fn(),
  },
}));
vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: { resolveState: vi.fn(), runWithUserTransitionLock: vi.fn(), prepareForLobbyEntry: vi.fn(), emitBlocked: vi.fn() },
}));
vi.mock('../../src/realtime/services/lobby-commands.service.js', () => ({ joinByCode: vi.fn() }));
vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeSocket(userId: string) {
  const emit = vi.fn();
  return { socket: { data: { user: { id: userId } }, emit } as never, emit };
}

describe('challengeFriend — bot target guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a BEFRIENDED persistent-bot target with a generic unavailable error', async () => {
    getByIdMock.mockResolvedValue({ id: 'bot-1', is_ai: true, ai_kind: 'persistent' });
    friendshipExistsMock.mockResolvedValue(true);

    const { challengeFriend } = await import('../../src/realtime/services/lobby-challenge.service.js');
    const { socket, emit } = makeSocket('human-1');

    await challengeFriend({} as never, socket, { toUserId: 'bot-1' });

    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({
      code: 'LOBBY_CHALLENGE_INVALID',
      message: 'This player is unavailable',
    }));
  });

  it('answers NOT_FRIENDS for a non-friend bot target — no bot-classification oracle', async () => {
    // Friendship is checked FIRST: a stranger probing an arbitrary UUID must get
    // the exact same error for a roster bot as for a human stranger.
    getByIdMock.mockResolvedValue({ id: 'bot-2', is_ai: true, ai_kind: 'persistent' });
    friendshipExistsMock.mockResolvedValue(false);

    const { challengeFriend } = await import('../../src/realtime/services/lobby-challenge.service.js');
    const { socket, emit } = makeSocket('human-1');

    await challengeFriend({} as never, socket, { toUserId: 'bot-2' });

    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'LOBBY_CHALLENGE_NOT_FRIENDS' }));
    expect(emit).not.toHaveBeenCalledWith('error', expect.objectContaining({ code: 'LOBBY_CHALLENGE_INVALID' }));
  });

  it('rejects a befriended ephemeral-bot target the same way as persistent', async () => {
    getByIdMock.mockResolvedValue({ id: 'bot-3', is_ai: true, ai_kind: 'ephemeral' });
    friendshipExistsMock.mockResolvedValue(true);

    const { challengeFriend } = await import('../../src/realtime/services/lobby-challenge.service.js');
    const { socket, emit } = makeSocket('human-1');

    await challengeFriend({} as never, socket, { toUserId: 'bot-3' });

    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'LOBBY_CHALLENGE_INVALID' }));
  });

  it('lets a human target proceed past the bot guard to the friendship check', async () => {
    getByIdMock.mockResolvedValue({ id: 'human-2', is_ai: false, ai_kind: null });
    friendshipExistsMock.mockResolvedValue(false);

    const { challengeFriend } = await import('../../src/realtime/services/lobby-challenge.service.js');
    const { socket, emit } = makeSocket('human-1');

    await challengeFriend({} as never, socket, { toUserId: 'human-2' });

    // Not a friend → the friendship check ran and produced its own error, proving
    // the human was NOT stopped by the bot guard.
    expect(friendshipExistsMock).toHaveBeenCalledWith('human-1', 'human-2');
    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'LOBBY_CHALLENGE_NOT_FRIENDS' }));
  });
});
