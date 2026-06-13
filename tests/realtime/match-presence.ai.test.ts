import { beforeEach, describe, expect, it, vi } from 'vitest';

// Focused unit test of resolveMatchPresence for the ranked-vs-AI reconnect-limit
// scenario that was previously UNTESTED. This pins down what the presence fork
// actually returns when a human limit-breaker (reconnected via user-room socket,
// disconnect marker cleared by the race) faces an AI opponent.

const getByIdsMock = vi.fn();
const getRedisClientMock = vi.fn();
const fetchMatchRoomUserIdsMock = vi.fn();

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: { getByIds: (...a: unknown[]) => getByIdsMock(...a) },
}));
vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => getRedisClientMock(),
}));

describe('resolveMatchPresence — ranked vs AI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Redis: human u1 has NO disconnect marker (racing reconnect cleared it),
    // no presence key, no exit-pending. AI has none of those either.
    getRedisClientMock.mockReturnValue({
      isOpen: true,
      exists: vi.fn(async () => 0),
    });
  });

  async function callPresence(opts: {
    aiPresent: boolean;
    humanInUserRoom: boolean;
    humanInDisconnectedSet: boolean;
  }) {
    const { resolveMatchPresence } = await import('../../src/realtime/services/match-presence.service.js');
    getByIdsMock.mockResolvedValue(
      new Map([
        ['u1', { id: 'u1', is_ai: false }],
        ['ai-bot', { id: 'ai-bot', is_ai: true }],
      ])
    );
    // io.in(room).fetchSockets — only the human's user room may have a socket.
    const io = {
      in: vi.fn((room: string) => ({
        fetchSockets: vi.fn(async () =>
          opts.humanInUserRoom && room === 'user:u1' ? [{ id: 's-u1' }] : []
        ),
      })),
    } as never;
    const roster = [
      { user_id: 'u1' },
      { user_id: 'ai-bot' },
    ];
    return resolveMatchPresence(io, 'm1', roster, {
      disconnectedUserIds: opts.humanInDisconnectedSet ? ['u1'] : [],
      includeUserRoomSockets: true,
    });
  }

  it('the human limit-breaker is ABSENT and the AI is PRESENT (so the forfeit fork can isolate one absent player)', async () => {
    // The reconnect_limit caller passes the human in disconnectedUserIds, so even
    // with a racing reconnect (user-room socket, no marker) the human must be the
    // single absent player and the AI the single present player.
    const presence = await callPresence({
      aiPresent: true,
      humanInUserRoom: true,
      humanInDisconnectedSet: true,
    });
    expect(presence.absentPlayers.map((p) => p.user_id)).toEqual(['u1']);
    expect(presence.presentPlayers.map((p) => p.user_id)).toEqual(['ai-bot']);
  });

  it('DANGER CASE — if the human is NOT in the disconnected set, the racing user-room socket makes them PRESENT, leaving zero absent players (fork fails → progress branch)', async () => {
    // This is the runtime shape that lets a leading limit-breaker win from
    // progress: marker cleared + user-room socket + not flagged disconnected.
    const presence = await callPresence({
      aiPresent: true,
      humanInUserRoom: true,
      humanInDisconnectedSet: false,
    });
    // Both look present → absentPlayers is empty → the forfeit fork cannot fire.
    expect(presence.absentPlayers).toHaveLength(0);
  });
});
