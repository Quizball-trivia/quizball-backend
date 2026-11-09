import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  lobby: { id: 'room', mode: 'friendly', status: 'waiting', is_public: false, host_user_id: 'host', game_mode: 'auction' } as Record<string, unknown>,
  members: new Set<string>(),
  sockets: [] as Array<{ data: { user: { id: string } } }>,
  leases: new Map<string, { token: string; expires_at: string }>(),
  deleted: false,
  pending: [] as Promise<unknown>[],
  removed: vi.fn(),
  due: [] as Array<{ lobby_id: string; user_id: string; token: string; expires_at: string }>,
  adapterDown: false,
  schedulerDown: false,
}));
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../src/realtime/client-games.js', () => ({ declares: () => true, declaresRoomOptions: () => true }));
vi.mock('../../src/modules/lobbies/lobbies.service.js', () => ({ lobbiesService: { buildLobbyState: vi.fn() } }));
vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({ userSessionGuardService: { emitState: vi.fn() } }));
vi.mock('../../src/realtime/services/lobby-draft-start.service.js', () => ({ startDraft: vi.fn() }));
vi.mock('../../src/realtime/services/lobby-membership.helpers.js', () => ({ transferHostIfNeeded: vi.fn(), removeUserFromLobbySockets: vi.fn(), emitClosedLobbyStateForMode: vi.fn() }));
vi.mock('../../src/realtime/services/warmup-realtime.service.js', () => ({ warmupRealtimeService: { cleanupLobby: vi.fn() } }));
vi.mock('../../src/realtime/locks.js', () => ({ releaseLock: vi.fn() }));
vi.mock('../../src/realtime/lobby-utils.js', () => ({
  attachUserSocketsToLobby: vi.fn(), emitLobbyState: vi.fn(),
  syncFriendlyLobbyModeForMemberCount: vi.fn(), syncFriendlyLobbyModeForMemberCountLocked: vi.fn(),
}));
vi.mock('../../src/realtime/services/lobby-lifecycle.helpers.js', () => ({
  acquireLobbyLockWithRetry: async () => ({ acquired: true, token: 'lock' }),
  isRankedAiLobby: () => false,
  closeLobbyIfEmpty: async () => { if (f.members.size) return false; f.deleted = true; return true; },
}));
vi.mock('../../src/realtime/socket-db-task-limiter.js', () => ({ socketDbTaskLimiter: {
  run: (fn: () => Promise<unknown>) => { const p = fn(); f.pending.push(p); return p; },
} }));
vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo: {
  getById: async () => f.deleted ? null : { ...f.lobby },
  findOpenLobbyForUser: async () => null,
  removeMember: async (_room: string, user: string) => { f.removed(user); f.members.delete(user); },
  countMembers: async () => f.members.size,
  reserveWaitingDisconnect: async (_room: string, user: string, token: string, graceMs: number) => {
    if (!f.members.has(user) || f.lobby.status !== 'waiting') return null;
    const lease = { token, expires_at: new Date(Date.now() + graceMs).toISOString() };
    f.leases.set(user, lease); return lease;
  },
  getWaitingDisconnect: async (_room: string, user: string) => f.leases.get(user) ?? null,
  clearWaitingDisconnect: async (_room: string, user: string) => { f.leases.delete(user); },
  removeWaitingDisconnectedMember: async (_room: string, user: string, token: string) => {
    const lease = f.leases.get(user);
    if (f.lobby.status !== 'waiting' || !lease || lease.token !== token || Date.parse(lease.expires_at) > Date.now()) return false;
    f.removed(user); f.members.delete(user); f.leases.delete(user); return true;
  },
  deleteEmptyWaitingLobby: async () => {
    if (f.lobby.status !== 'waiting' || f.members.size) return false;
    f.deleted = true; return true;
  },
  listDueWaitingDisconnects: async () => f.due,
} }));
vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  scheduleRealtimeTimer: async (_kind: string, _key: string, at: Date, payload: unknown) => {
    if (f.schedulerDown) throw new Error('scheduler unavailable');
    setTimeout(() => {
      const p = import('../../src/realtime/services/lobby-connect.service.js').then(m =>
        (m as unknown as { expireWaitingLobbyDisconnect: (io: unknown, p: unknown) => Promise<void> }).expireWaitingLobbyDisconnect(io, payload));
      void p.catch(() => undefined);
      f.pending.push(p);
    }, Math.max(0, at.getTime() - Date.now()));
  },
}));

const io = { in: () => ({ fetchSockets: async () => { if (f.adapterDown) throw new Error('adapter unavailable'); return f.sockets; } }), to: () => ({ emit: vi.fn() }) };
const socket = (user = 'host') => ({ id: user, data: { lobbyId: 'room', user: { id: user }, connectedAt: Date.now() } });
async function disconnect(user = 'host') {
  const { handleLobbyDisconnect } = await import('../../src/realtime/services/lobby-connect.service.js');
  await handleLobbyDisconnect(io as never, socket(user) as never);
}
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  while (f.pending.length) await Promise.all(f.pending.splice(0));
}
describe('waiting friend-room disconnect reservations', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-09T09:00:00Z'));
    f.lobby = { id: 'room', mode: 'friendly', status: 'waiting', is_public: false, host_user_id: 'host', game_mode: 'auction' };
    f.members = new Set(['host']); f.sockets = []; f.leases.clear(); f.deleted = false; f.pending = []; f.removed.mockClear(); f.due = []; f.adapterDown = false; f.schedulerDown = false;
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the same private room and host seat after the original 15s cleanup and for two minutes', async () => {
    await disconnect(); await advance(120_000);
    expect(f.deleted).toBe(false); expect(f.members.has('host')).toBe(true); expect(f.removed).not.toHaveBeenCalled();
  });
  it('expires a genuinely abandoned private waiting room after five minutes', async () => {
    await disconnect(); await advance(299_999); expect(f.deleted).toBe(false);
    await advance(1); expect(f.deleted).toBe(true);
  });
  it('keeps the public room cleanup duration at 15 seconds', async () => {
    f.lobby.is_public = true; await disconnect(); await advance(15_000); expect(f.deleted).toBe(true);
  });
  it('does not let the first timer shorten the grace after reconnect then a second disconnect', async () => {
    f.lobby.is_public = true; await disconnect(); await advance(5_000);
    f.leases.delete('host'); f.sockets = [socket()];
    await advance(5_000); f.sockets = []; await disconnect();
    await advance(5_000); expect(f.deleted).toBe(false);
    await advance(10_000); expect(f.deleted).toBe(true);
  });
  it('never lets old waiting-room timers remove members after the game becomes active', async () => {
    f.lobby.is_public = true; f.members.add('friend');
    await disconnect(); await disconnect('friend'); f.lobby.status = 'active';
    await advance(15_000);
    expect(f.deleted).toBe(false); expect(f.members.size).toBe(2); expect(f.removed).not.toHaveBeenCalled();
  });
  it('ignores an obsolete disconnect when another socket is already present', async () => {
    f.sockets = [socket()]; await disconnect(); await advance(300_000);
    expect(f.leases.size).toBe(0); expect(f.deleted).toBe(false);
  });
  it('preserves an already-joined friend when the host reservation expires', async () => {
    await disconnect(); await advance(30_000); f.members.add('friend');
    await advance(270_000);
    expect(f.deleted).toBe(false); expect([...f.members]).toEqual(['friend']);
  });
  it('does not resurrect a room explicitly left before its timer fires', async () => {
    await disconnect(); f.members.clear(); f.leases.clear(); f.deleted = true;
    await advance(300_000); expect(f.deleted).toBe(true); expect(f.removed).not.toHaveBeenCalled();
  });
  it('recovers a due persisted reservation when Redis scheduling was unavailable', async () => {
    f.schedulerDown = true;
    await expect(disconnect()).rejects.toThrow('scheduler unavailable');
    const lease = f.leases.get('host')!;
    expect(lease).toBeDefined();
    await advance(300_000);
    f.due = [{ lobby_id: 'room', user_id: 'host', ...lease }];
    const { recoverWaitingLobbyDisconnects } = await import('../../src/realtime/services/lobby-disconnect.service.js');
    await recoverWaitingLobbyDisconnects(io as never);
    expect(f.deleted).toBe(true);
  });
  it('fails safely on an unreadable presence adapter and retries the persisted reservation', async () => {
    await disconnect(); const lease = f.leases.get('host')!;
    f.adapterDown = true;
    await expect(advance(300_000)).rejects.toThrow('adapter unavailable');
    expect(f.deleted).toBe(false); expect(f.members.has('host')).toBe(true);
    f.adapterDown = false; f.due = [{ lobby_id: 'room', user_id: 'host', ...lease }];
    const { recoverWaitingLobbyDisconnects } = await import('../../src/realtime/services/lobby-disconnect.service.js');
    await recoverWaitingLobbyDisconnects(io as never);
    expect(f.deleted).toBe(true);
  });

});
