import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const redisStore = new Map<string, string>();
const queue = new Set<string>();
const userMap = new Map<string, string>();
const fakeRedis = {
  isOpen: true,
  get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
  zRem: vi.fn(async (_k: string, id: string) => { queue.delete(id); return 1; }),
  hDel: vi.fn(async (_k: string, field: string) => { userMap.delete(field); return 1; }),
  hGet: vi.fn(async (_key: string, field: string) => userMap.get(field) ?? null),
  multi: () => {
    const ops: Array<() => void> = [];
    const chain = {
      zRem: (_k: string, id: string | string[]) => { ops.push(() => { for (const x of [id].flat()) queue.delete(x); }); return chain; },
      hDel: (_k: string, field: string) => { ops.push(() => { userMap.delete(field); }); return chain; },
      del: (key: string) => { ops.push(() => { redisStore.delete(key); }); return chain; },
      exec: async () => { ops.forEach((op) => op()); return []; },
    };
    return chain;
  },
};
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => fakeRedis }));
const cancelTimer = vi.fn(async () => {});
vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({ cancelRealtimeTimer: cancelTimer, scheduleRealtimeTimer: vi.fn(async () => {}) }));
const startBot = vi.fn();
vi.mock('../../src/modules/room/games/zone-match/zone-match.bot.js', () => ({ createZoneBotUser: vi.fn(), deleteZoneBotUser: vi.fn(), startZoneMatchBot: startBot }));

const { config } = await import('../../src/core/config.js');
const { roomService } = await import('../../src/modules/room/room.service.js');
const { zoneMatchMatchmakingService } = await import('../../src/realtime/services/zone-match-matchmaking.service.js');
const { userSessionGuardService } = await import('../../src/realtime/services/user-session-guard.service.js');

const flags = config as unknown as { ROOM_GAMES_DISABLED: string[]; ZONE_MATCH_QUEUE_ENABLED: boolean; ZONE_MATCH_BOT_ENABLED: boolean };
const original = { disabled: [...(flags.ROOM_GAMES_DISABLED ?? [])], queue: flags.ZONE_MATCH_QUEUE_ENABLED, bot: flags.ZONE_MATCH_BOT_ENABLED };
beforeEach(() => {
  redisStore.clear(); queue.clear(); userMap.clear(); cancelTimer.mockClear();
  vi.spyOn(userSessionGuardService, 'emitState').mockResolvedValue(undefined as never);
  vi.spyOn(userSessionGuardService, 'withUserSessionLock').mockImplementation(async (_u, work) => work());
});
afterEach(() => { flags.ROOM_GAMES_DISABLED = [...original.disabled]; flags.ZONE_MATCH_QUEUE_ENABLED = original.queue; flags.ZONE_MATCH_BOT_ENABLED = original.bot; vi.restoreAllMocks(); });

describe('a room game switched off by ROOM_GAMES_DISABLED', () => {
  it('cannot be started from any path into a room', async () => {
    flags.ROOM_GAMES_DISABLED = ['zone_match'];
    await expect(roomService.createFromLobby({ lobbyId: 'l', game: 'zone_match', players: [{ userId: 'a', isGuest: false }, { userId: 'b', isGuest: false, isBot: true }] }))
      .rejects.toMatchObject({ code: 'room_game_disabled' });
  });
  it('leaves a newer search of the same player alone when an old timer fires after the switch', async () => {
    flags.ZONE_MATCH_QUEUE_ENABLED = true; flags.ZONE_MATCH_BOT_ENABLED = true;
    flags.ROOM_GAMES_DISABLED = ['zone_match'];
    queue.add('s1'); queue.add('s2'); userMap.set('u1', 's2');
    const io = { to: () => ({ emit: () => {} }) } as never;
    await zoneMatchMatchmakingService.handleFallbackTimer(io, 's1', 'u1');
    expect(queue.has('s1')).toBe(false);
    expect(userMap.get('u1')).toBe('s2');
  });
  for (const recordGone of [false, true]) {
    it(`ends a Zone match search whose fallback timer fires after the switch${recordGone ? ' (its record already expired)' : ''}, seating no one`, async () => {
      flags.ZONE_MATCH_QUEUE_ENABLED = true; flags.ZONE_MATCH_BOT_ENABLED = true;
      flags.ROOM_GAMES_DISABLED = ['zone_match'];
      if (!recordGone) redisStore.set('zone_match:mm:search:s1', JSON.stringify({ searchId: 's1', userId: 'u1', queuedAt: Date.now(), fallbackAt: Date.now() }));
      queue.add('s1'); userMap.set('u1', 's1');
      const emitted: unknown[] = [];
      const io = { to: () => ({ emit: (...args: unknown[]) => emitted.push(args) }) } as never;
      const create = vi.spyOn(roomService, 'createFromLobby');
      await zoneMatchMatchmakingService.handleFallbackTimer(io, 's1', 'u1');
      expect(create).not.toHaveBeenCalled();
      expect(startBot).not.toHaveBeenCalled();
      expect(redisStore.has('zone_match:mm:search:s1')).toBe(false);
      expect(queue.has('s1')).toBe(false);
      expect(userMap.has('u1')).toBe(false);
      expect(cancelTimer).toHaveBeenCalled();
      expect(emitted).toContainEqual(['zone:search_state', { state: 'idle', searchId: 's1' }]);
    });
  }
});
