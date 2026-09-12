/**
 * Guest rooms through the real lobby command service: the create path opens in
 * a playable mode and is budgeted, the join path validates the room the join
 * would leave behind (final normalized mode + guest cap) under the lobby lock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

vi.setConfig({ testTimeout: 30_000 });

const lobbiesRepo = {
  createLobby: vi.fn(), addMember: vi.fn(), getByInviteCode: vi.fn(), getById: vi.fn(), listMembersWithUser: vi.fn(),
  countMembers: vi.fn(), countReadyMembers: vi.fn(), updateLobbySettings: vi.fn(), setAllReady: vi.fn(), setVisibility: vi.fn(),
};
const allowGuestOperation = vi.fn();
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo }));
vi.mock('../../src/modules/guest/guest-rate-limit.js', () => ({ allowGuestOperation: (...a: unknown[]) => allowGuestOperation(...a) }));
vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    prepareForLobbyEntry: vi.fn().mockResolvedValue({ ok: true }),
    runWithUserTransitionLock: async (_io: unknown, _socket: unknown, fn: () => Promise<void>) => { await fn(); return true; },
    emitBlocked: vi.fn(), emitState: vi.fn(), resolveState: vi.fn(),
  },
}));
vi.mock('../../src/realtime/services/lobby-lifecycle.helpers.js', () => ({
  acquireLobbyLockWithRetry: vi.fn().mockResolvedValue({ acquired: true, token: 't' }),
  closeLobbyIfEmpty: vi.fn(), isRankedAiLobby: () => false, releaseRankedAiLobbyMemberSafely: vi.fn(),
  resolveLobbyId: (socket: { data: { lobbyId?: string } }, override?: string) => override ?? socket.data.lobbyId ?? null,
}));
vi.mock('../../src/realtime/locks.js', () => ({ acquireLock: vi.fn().mockResolvedValue({ acquired: true, token: 't' }), releaseLock: vi.fn() }));
vi.mock('../../src/realtime/lobby-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/lobby-utils.js')>();
  return { ...actual, attachUserSocketsToLobby: vi.fn(), emitLobbyState: vi.fn(), syncFriendlyLobbyModeForMemberCountLocked: vi.fn() };
});
vi.mock('../../src/realtime/services/lobby-ranked-ai.service.js', () => ({ startRankedAiForUser: vi.fn() }));
vi.mock('../../src/db/readonly-breaker.js', () => ({ isDbWriteOutage: () => false, DbWriteOutageError: class extends Error {} }));

const { createLobby, joinByCode, updateSettings } = await import('../../src/realtime/services/lobby-commands.service.js');
const { config } = await import('../../src/core/config.js');
const flags = config as unknown as { FOOTBALL_GRID_LOBBY_ENABLED: boolean; GUEST_LOBBIES_PROVISIONING_ENABLED: boolean };
flags.FOOTBALL_GRID_LOBBY_ENABLED = true;
flags.GUEST_LOBBIES_PROVISIONING_ENABLED = true;

const socketFor = (id: string, guest = false, lobbyId?: string) => ({ id: `s-${id}`, data: { user: { id, is_guest: guest }, lobbyId }, emit: vi.fn(), join: vi.fn() });
const io = { to: vi.fn(() => ({ emit: vi.fn() })), in: vi.fn(() => ({ fetchSockets: async () => [] })) };
const member = (id: string, guest = false) => ({ lobby_id: 'L', user_id: id, is_ready: false, joined_at: '2026-01-01', nickname: id, avatar_url: null, avatar_customization: null, favorite_club: null, is_ai: false, ai_kind: null, is_guest: guest });
const lobby = (gameMode: string, host = 'host') => ({ id: 'L', invite_code: 'ABC123', mode: 'friendly', status: 'waiting', host_user_id: host, game_mode: gameMode, friendly_random: true, friendly_category_a_id: null, friendly_category_b_id: null, is_public: false });

describe('guest rooms — create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowGuestOperation.mockResolvedValue(true);
    lobbiesRepo.createLobby.mockImplementation(async (data: { gameMode?: string }) => ({ id: 'L', game_mode: data.gameMode ?? 'friendly_possession' }));
    lobbiesRepo.addMember.mockResolvedValue(undefined);
  });

  it('a guest host opens the room in Tic Tac Toe, a member host keeps the default', async () => {
    await createLobby(io as never, socketFor('g', true) as never, { mode: 'friendly', correlationId: 'c' });
    expect(lobbiesRepo.createLobby.mock.calls[0][0]).toMatchObject({ gameMode: 'football_grid' });
    await createLobby(io as never, socketFor('m') as never, { mode: 'friendly', correlationId: 'c' });
    expect(lobbiesRepo.createLobby.mock.calls[1][0].gameMode).toBeUndefined();
  });

  it('is budgeted per guest and refuses ranked rooms for guests', async () => {
    allowGuestOperation.mockResolvedValueOnce(false);
    const limited = await createLobby(io as never, socketFor('g', true) as never, { mode: 'friendly', correlationId: 'c' });
    expect(limited).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    const ranked = await createLobby(io as never, socketFor('g', true) as never, { mode: 'ranked', correlationId: 'c' });
    expect(ranked).toMatchObject({ ok: false, code: 'CAPABILITY_REQUIRED' });
  });
});

describe('guest rooms — join by code', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lobbiesRepo.addMember.mockResolvedValue(undefined);
  });
  const room = (gameMode: string, members: ReturnType<typeof member>[]) => {
    lobbiesRepo.getByInviteCode.mockResolvedValue(lobby(gameMode));
    lobbiesRepo.getById.mockResolvedValue(lobby(gameMode));
    lobbiesRepo.listMembersWithUser.mockResolvedValue(members);
  };

  it('a guest joins a grid room', async () => {
    room('football_grid', [member('host')]);
    const result = await joinByCode(io as never, socketFor('g', true) as never, 'abc123', 'c');
    expect(result).toMatchObject({ ok: true });
    expect(lobbiesRepo.addMember).toHaveBeenCalledWith('L', 'g', false);
  });

  it('a guest cannot join a room whose FINAL mode would be locked (third member → party quiz)', async () => {
    room('ranked_sim', [member('a'), member('b')]);
    const result = await joinByCode(io as never, socketFor('g', true) as never, 'abc123', 'c');
    expect(result).toMatchObject({ ok: false, code: 'LOBBY_MODE_REQUIRES_ACCOUNT' });
    expect(lobbiesRepo.addMember).not.toHaveBeenCalled();
  });

  it('a member cannot join a guest room in a locked mode either, and the fourth guest is refused', async () => {
    room('friendly_possession', [member('g1', true)]);
    expect(await joinByCode(io as never, socketFor('m') as never, 'abc123', 'c')).toMatchObject({ ok: false, code: 'LOBBY_MODE_REQUIRES_ACCOUNT' });
    room('auction', [member('g1', true), member('g2', true), member('g3', true)]);
    expect(await joinByCode(io as never, socketFor('g4', true) as never, 'abc123', 'c')).toMatchObject({ ok: false, code: 'LOBBY_GUEST_LIMIT' });
    room('football_grid', [member('m1'), member('g1', true)]);
    expect(await joinByCode(io as never, socketFor('g2', true) as never, 'abc123', 'c')).toMatchObject({ ok: false, code: 'LOBBY_FULL' });
    room('friendly_party_quiz', [member('g1', true), member('g2', true), member('g3', true), member('m1')]);
    expect(await joinByCode(io as never, socketFor('g4', true) as never, 'abc123', 'c')).toMatchObject({ ok: false, code: 'LOBBY_GUEST_LIMIT' });
  });

  it('an already-present guest rejoining is exempt from the checks', async () => {
    room('auction', [member('g1', true), member('g2', true), member('g3', true)]);
    expect(await joinByCode(io as never, socketFor('g3', true) as never, 'abc123', 'c')).toMatchObject({ ok: true, alreadyMember: true });
  });
});

describe('guest rooms — settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lobbiesRepo.countReadyMembers.mockResolvedValue(0);
    lobbiesRepo.updateLobbySettings.mockResolvedValue(undefined);
    lobbiesRepo.setAllReady.mockResolvedValue(0);
  });

  it('the host cannot switch a guest room to Friendly match; switching to Auction works', async () => {
    lobbiesRepo.getById.mockResolvedValue(lobby('football_grid'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host'), member('g', true)]);
    const host = socketFor('host', false, 'L');
    await updateSettings(io as never, host as never, { gameMode: 'friendly_possession' });
    expect(host.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'LOBBY_MODE_REQUIRES_ACCOUNT' }));
    expect(lobbiesRepo.updateLobbySettings).not.toHaveBeenCalled();
    await updateSettings(io as never, host as never, { gameMode: 'auction' });
    expect(lobbiesRepo.updateLobbySettings).toHaveBeenCalledWith('L', expect.objectContaining({ gameMode: 'auction' }));
  });

  it('re-validates ownership on the locked row (host transferred in between)', async () => {
    lobbiesRepo.getById.mockResolvedValueOnce(lobby('football_grid', 'host')).mockResolvedValueOnce(lobby('football_grid', 'other'));
    const host = socketFor('host', false, 'L');
    await updateSettings(io as never, host as never, { gameMode: 'auction' });
    expect(host.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'NOT_HOST' }));
  });
});

describe('guest rooms — drain (provisioning off)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowGuestOperation.mockResolvedValue(true);
    flags.GUEST_LOBBIES_PROVISIONING_ENABLED = false;
    lobbiesRepo.createLobby.mockImplementation(async (data: { gameMode?: string }) => ({ id: 'L', game_mode: data.gameMode ?? 'friendly_possession' }));
    lobbiesRepo.addMember.mockResolvedValue(undefined);
    lobbiesRepo.getByInviteCode.mockResolvedValue(lobby('football_grid'));
    lobbiesRepo.getById.mockResolvedValue(lobby('football_grid'));
  });
  afterEach(() => { flags.GUEST_LOBBIES_PROVISIONING_ENABLED = true; });

  it('a guest can neither open a room nor join a new one; members are unaffected', async () => {
    const created = await createLobby(io as never, socketFor('g', true) as never, { mode: 'friendly', correlationId: 'c' });
    expect(created).toMatchObject({ ok: false, code: 'CAPABILITY_REQUIRED' });
    expect(lobbiesRepo.createLobby).not.toHaveBeenCalled();

    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host')]);
    const joined = await joinByCode(io as never, socketFor('g', true) as never, 'ABC123', 'c');
    expect(joined).toMatchObject({ ok: false, code: 'CAPABILITY_REQUIRED' });
    expect(lobbiesRepo.addMember).not.toHaveBeenCalled();

    const memberJoined = await joinByCode(io as never, socketFor('m') as never, 'ABC123', 'c');
    expect(memberJoined).toMatchObject({ ok: true });
  });

  it('a guest already in the room may still rejoin (finishing a live game)', async () => {
    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host'), member('g', true)]);
    const rejoined = await joinByCode(io as never, socketFor('g', true) as never, 'ABC123', 'c');
    expect(rejoined).toMatchObject({ ok: true, alreadyMember: true });
  });
});
