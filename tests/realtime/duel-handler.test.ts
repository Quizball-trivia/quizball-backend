import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

// The gameplay DB limiter covers a duel command's database write only (review 2026-10-06, P1-2): a burst of commands
// never has more writes in flight than the limit, and the state broadcast after a write never holds a slot.
const { calls, release, snapshots } = vi.hoisted(() => ({
  calls: [] as string[], release: [] as Array<() => void>, snapshots: { hang: false },
}));
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/realtime/services/duel-rate-limit.service.js', () => ({ allowDuelOperation: vi.fn(async () => true) }));
vi.mock('../../src/modules/duel/duel.config.js', () => ({ anyDuelGameEnabled: () => true }));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));
vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({ scheduleRealtimeTimer: vi.fn() }));
vi.mock('../../src/realtime/lobby-utils.js', () => ({ emitLobbyState: vi.fn() }));
vi.mock('../../src/modules/duel/duel.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/modules/duel/duel.service.js')>()),
  duelService: {
    command: vi.fn((matchId: string, _userId: string, commandId: string) => new Promise((resolve) => {
      calls.push(commandId);
      release.push(() => resolve({ result: { ok: true }, effects: { matchId, lobbyId: 'L', userIds: ['user'], timer: null, finished: false } }));
    })),
    snapshots: vi.fn(() => (snapshots.hang ? new Promise(() => {}) : Promise.resolve(new Map()))),
  },
}));
const { registerDuelHandlers } = await import('../../src/realtime/handlers/duel.handler.js');
const { gameplayDbTaskLimiter } = await import('../../src/realtime/socket-db-task-limiter.js');

const handlersFor = () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const socket = { data: { user: { id: 'user' } }, on: (event: string, fn: (payload: unknown) => void) => handlers.set(event, fn), emit: vi.fn() };
  const io = { to: () => ({ emit: vi.fn() }) };
  registerDuelHandlers(io as never, socket as never);
  return handlers;
};
const command = (i: number) => ({
  matchId: '00000000-0000-4000-8000-000000000001',
  commandId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, command: { type: 'guess' },
});

describe('duel socket admission', () => {
  it('a command burst never has more database writes in flight than the gameplay limit; the rest wait their turn', async () => {
    const handlers = handlersFor();
    const limit = gameplayDbTaskLimiter.stats().limit;
    for (let i = 0; i < limit + 2; i++) handlers.get('duel:command')!(command(i));
    await vi.waitFor(() => expect(calls).toHaveLength(limit));
    expect(gameplayDbTaskLimiter.stats()).toMatchObject({ active: limit, queued: 2 });
    while (release.length) {
      release.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await vi.waitFor(() => expect(calls).toHaveLength(limit + 2));
    release.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(gameplayDbTaskLimiter.stats()).toMatchObject({ active: 0, queued: 0 }));
  });

  it('a stuck state broadcast does not hold the gameplay slot of the command that caused it', async () => {
    calls.length = 0;
    release.length = 0;
    snapshots.hang = true;
    const handlers = handlersFor();
    handlers.get('duel:command')!(command(99));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gameplayDbTaskLimiter.stats().active).toBe(0);
    snapshots.hang = false;
  });
});
