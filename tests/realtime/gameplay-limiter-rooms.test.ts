import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

// P1-2 (review 2026-10-06): a room command held a gameplay DB slot while it waited for the room's state broadcast
// (stateDeliveries: 2 slots, up to 5 s), so a delivery backlog pinned every gameplay slot and other games' answers timed out.
const roomService = vi.hoisted(() => ({
  command: vi.fn(), snapshots: vi.fn(), snapshot: vi.fn().mockResolvedValue(null), present: vi.fn().mockResolvedValue(null),
  liveMatchFor: vi.fn(), sittingOutFor: vi.fn(), setLocale: vi.fn(), anyLive: vi.fn(),
}));
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/modules/room/room.service.js', () => ({ roomService }));
vi.mock('../../src/modules/room/room.config.js', () => ({ anyRoomGameEnabled: () => true }));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));
vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({ scheduleRealtimeTimer: vi.fn() }));
vi.mock('../../src/realtime/lobby-utils.js', () => ({ emitLobbyState: vi.fn() }));
vi.mock('../../src/realtime/services/duel-rate-limit.service.js', () => ({ allowDuelOperation: vi.fn(async () => true) }));

const { registerRoomHandlers } = await import('../../src/realtime/handlers/room.handler.js');
const { gameplayDbTaskLimiter } = await import('../../src/realtime/socket-db-task-limiter.js');

describe('gameplay limiter scope: room commands', () => {
  it('the gameplay slot is released once the command commits, before the state broadcast finishes', async () => {
    const matchId = '22222222-2222-4222-8222-222222222222';
    roomService.command.mockResolvedValue({
      result: { ok: true },
      effects: { matchId, lobbyId: 'L', userIds: ['u1', 'u2'], status: 'active', timer: null, finished: false },
    });
    // The broadcast's snapshot read is stuck (a delivery backlog / slow DB).
    roomService.snapshots.mockReturnValue(new Promise(() => {}));

    const handlers = new Map<string, (payload: unknown) => void>();
    const emitted: string[] = [];
    const socket = { data: { user: { id: 'u1' } }, on: (event: string, fn: (payload: unknown) => void) => handlers.set(event, fn), emit: (event: string) => { emitted.push(event); } };
    const io = { to: () => ({ emit: vi.fn() }), in: () => ({ fetchSockets: async () => [] }) };
    registerRoomHandlers(io as never, socket as never);
    handlers.get('room:command')!({ matchId, commandId: '33333333-3333-4333-8333-333333333333', command: { type: 'guess', value: 42 } });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(roomService.command).toHaveBeenCalledOnce();
    expect(emitted).toContain('room:command_result');
    expect(gameplayDbTaskLimiter.stats().active).toBe(0);
  });
});
