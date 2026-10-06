import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const roomService = vi.hoisted(() => {
  const service = {
    liveMatchFor: vi.fn(), sittingOutFor: vi.fn(), present: vi.fn(), snapshot: vi.fn().mockResolvedValue(null), snapshots: vi.fn().mockResolvedValue(new Map()), setLocale: vi.fn(), anyLive: vi.fn(), expire: vi.fn(),
    // The pointer read: the live seat these tests script through liveMatchFor, stamped with a database time.
    livePointerFor: async (userId: string) => ({ asOf: 1_000, live: await service.liveMatchFor(userId) }),
  };
  return service;
});
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/modules/room/room.service.js', () => ({ roomService }));
vi.mock('../../src/modules/room/room.config.js', () => ({ anyRoomGameEnabled: () => true }));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));
vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({ scheduleRealtimeTimer: vi.fn() }));
vi.mock('../../src/realtime/lobby-utils.js', () => ({ emitLobbyState: vi.fn() }));

const { roomRealtimeService } = await import('../../src/realtime/services/room-realtime.service.js');

const socketFor = () => {
  const emitted: Array<[string, unknown]> = [];
  return { emitted, connected: true, data: { user: { id: 'u1' } } as Record<string, unknown> & { roomMatchId?: string }, emit: (e: string, p: unknown) => { emitted.push([e, p]); } };
};
const io = { to: () => ({ emit: vi.fn() }), in: () => ({ fetchSockets: async () => [] }) };
const live = (id: string) => ({ id, game: 'aproximado', lobby_id: 'L' });
/** A change about u1's match delivered while the lookup runs (a leave, a start, the end). */
const deliveredMeanwhile = (matchId: string) => roomRealtimeService.deliver(io as never, { matchId, lobbyId: 'L', userIds: ['u1'], status: 'active', timer: null, finished: false });

describe('room connect pointer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roomService.present.mockResolvedValue(null);
    roomService.sittingOutFor.mockResolvedValue(null);
  });

  it('points the player at their live seat and marks them present', async () => {
    roomService.liveMatchFor.mockResolvedValue(live('B'));
    const socket = socketFor();
    expect(await roomRealtimeService.onConnect(io as never, socket as never)).toBe(true);
    expect(socket.emitted).toEqual(expect.arrayContaining([['room:active', { matchId: 'B', game: 'aproximado', lobbyId: 'L' }], ['room:sitting_out', null], ['room:found', { matchId: 'B', game: 'aproximado', lobbyId: 'L' }]]));
    expect(roomService.present).toHaveBeenCalledWith('u1');
    expect(socket.data.roomMatchId).toBe('B');
  });

  it('a room event that commits during the lookup makes it read again: a leave just done is never pointed back to', async () => {
    const socket = socketFor();
    roomService.liveMatchFor
      .mockImplementationOnce(async () => { await deliveredMeanwhile('A'); return live('A'); }) // the leave of A committed meanwhile
      .mockResolvedValueOnce(null);
    roomService.sittingOutFor.mockResolvedValue({ id: 'A', lobby_id: 'L', left: true });
    expect(await roomRealtimeService.onConnect(io as never, socket as never)).toBe(false);
    expect(roomService.liveMatchFor).toHaveBeenCalledTimes(2);
    expect(socket.emitted).toEqual([['room:active', null], ['room:sitting_out', { matchId: 'A', lobbyId: 'L', reason: 'left' }]]);
  });

  it('...and a match announced during the lookup (a real start) is pointed to, not a stale "none"', async () => {
    const socket = socketFor();
    roomService.liveMatchFor
      .mockImplementationOnce(async () => { await roomRealtimeService.announce(io as never, { matchId: 'B', lobbyId: 'L', userIds: ['u1'], status: 'ready', timer: null, finished: false }, 'aproximado'); return null; })
      .mockResolvedValueOnce(live('B'));
    expect(await roomRealtimeService.onConnect(io as never, socket as never)).toBe(true);
    expect(socket.emitted[0]).toEqual(['room:active', { matchId: 'B', game: 'aproximado', lobbyId: 'L' }]);
  });

  it('...and a match delivered during the lookup is pointed to, not a stale "none"', async () => {
    const socket = socketFor();
    roomService.liveMatchFor
      .mockImplementationOnce(async () => { await deliveredMeanwhile('B'); return null; })
      .mockResolvedValueOnce(live('B'));
    expect(await roomRealtimeService.onConnect(io as never, socket as never)).toBe(true);
    expect(socket.emitted[0]).toEqual(['room:active', { matchId: 'B', game: 'aproximado', lobbyId: 'L' }]);
  });

  it('a resync for an old match never binds the socket to it', async () => {
    const socket = socketFor();
    roomService.snapshot.mockResolvedValue({ matchId: 'A', status: 'completed', me: { active: false } });
    await roomRealtimeService.handleResync(io as never, socket as never, { matchId: 'A' });
    expect(socket.data.roomMatchId).toBeUndefined();
    roomService.snapshot.mockResolvedValue({ matchId: 'B', status: 'active', me: { active: true } });
    await roomRealtimeService.handleResync(io as never, socket as never, { matchId: 'B' });
    expect(socket.data.roomMatchId).toBe('B');
  });

  it('presence is restored on connect even when the pointer read is deferred by concurrent deliveries', async () => {
    const socket = socketFor();
    roomService.liveMatchFor.mockImplementation(async () => { await deliveredMeanwhile('B'); return live('B'); });
    expect(await roomRealtimeService.onConnect(io as never, socket as never)).toBe(false);
    expect(socket.emitted.filter(([event]) => event === 'room:active')).toHaveLength(0); // no stale answer sent
    expect(roomService.present).toHaveBeenCalledWith('u1');
    roomService.liveMatchFor.mockReset();
  });

  it.each(['liveMatchFor', 'sittingOutFor'] as const)('presence still runs when the %s lookup fails', async (query) => {
    const socket = socketFor();
    roomService.liveMatchFor.mockResolvedValue(null);
    roomService[query].mockRejectedValueOnce(new Error('db down'));
    await roomRealtimeService.onConnect(io as never, socket as never);
    expect(roomService.present).toHaveBeenCalledWith('u1');
    roomService.liveMatchFor.mockReset();
  });


});

describe('room phase timer (review 2026-10-06 B2)', () => {
  it('finishes once the deadline is written and the next timer armed, without waiting for the state broadcast', async () => {
    const { scheduleRealtimeTimer } = await import('../../src/realtime/realtime-timer-scheduler.js');
    roomService.expire.mockResolvedValue({ matchId: 'M', lobbyId: 'L', userIds: ['u1', 'u2'], status: 'active', timer: { token: 3, dueAt: new Date() }, finished: false });
    roomService.snapshots.mockReturnValue(new Promise(() => {})); // a stuck snapshot read
    const outcome = await Promise.race([
      roomRealtimeService.handlePhaseTimer({} as never, { kind: 'room_phase', matchId: 'M', phaseToken: 2 } as never).then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500)),
    ]);
    expect(outcome).toBe('done');
    expect(scheduleRealtimeTimer).toHaveBeenCalledWith('room_phase', 'M', expect.any(Date), expect.objectContaining({ phaseToken: 3 }));
    roomService.snapshots.mockResolvedValue(new Map());
  });
});

describe('room presence memory (review 2026-10-06 B7)', () => {
  it('forgets users once their revisions and disconnect stamps are old, so churn does not grow memory forever', async () => {
    const before = roomRealtimeService.memoryStats();
    roomRealtimeService.markChanged(Array.from({ length: 1_000 }, (_, i) => `churn-${i}`));
    expect(roomRealtimeService.memoryStats().revisions).toBe(before.revisions + 1_000);
    roomRealtimeService.pruneMemory(Date.now() + 11 * 60_000);
    expect(roomRealtimeService.memoryStats()).toEqual({ revisions: 0, disconnects: 0 });
  });

  it('a revision taken before an eviction never equals the one after (no stale pointer can pass the re-read check)', async () => {
    roomRealtimeService.markChanged(['u-rev']);
    const first = roomRealtimeService.revisionOf('u-rev');
    roomRealtimeService.pruneMemory(Date.now() + 11 * 60_000);
    roomRealtimeService.markChanged(['u-rev']);
    expect(roomRealtimeService.revisionOf('u-rev')).not.toBe(first);
    expect(roomRealtimeService.revisionOf('u-rev')).toBeGreaterThan(first);
  });
});

describe('room pointer answers carry their read time (review 2026-10-06 W6)', () => {
  it('room:active and room:sitting_out both say as of when (database time) they were read', async () => {
    roomService.liveMatchFor.mockResolvedValue(null);
    roomService.sittingOutFor.mockResolvedValue(null);
    roomService.present.mockResolvedValue(null);
    const emit = vi.fn();
    const socket = { data: { user: { id: 'u-meta' } }, connected: true, emit };
    await roomRealtimeService.handlePointer(socket as never);
    expect(emit).toHaveBeenCalledWith('room:active', null, { asOf: 1_000 });
    expect(emit).toHaveBeenCalledWith('room:sitting_out', null, { asOf: 1_000 });
    roomService.liveMatchFor.mockReset();
  });
});

describe('pointer reads across a memory prune (review round 4 #8)', () => {
  it('a read that started before a prune reads again instead of trusting a revision the prune reset', async () => {
    roomService.sittingOutFor.mockResolvedValue(null);
    roomService.present.mockResolvedValue(null);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // First read: no seat yet, held open; meanwhile a start for this user lands and is later pruned.
    roomService.liveMatchFor
      .mockImplementationOnce(async () => { await gate; return null; })
      .mockResolvedValue({ id: 'M-live', game: 'aproximado', lobby_id: 'L' });
    const emit = vi.fn();
    const socket = { data: { user: { id: 'u-prune' } }, connected: true, emit };
    const answering = roomRealtimeService.handlePointer(socket as never);
    await Promise.resolve();
    roomRealtimeService.markChanged(['u-prune']);
    roomRealtimeService.pruneMemory(Date.now() + 11 * 60_000);
    release();
    await answering;
    expect(emit).not.toHaveBeenCalledWith('room:active', null, expect.anything());
    expect(emit).toHaveBeenCalledWith('room:active', expect.objectContaining({ matchId: 'M-live' }), expect.anything());
    roomService.liveMatchFor.mockReset();
  });
});

