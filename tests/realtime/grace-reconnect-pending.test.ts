import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

// Reconnect-pending deferral — the ROOT fix for the Thenotorious case
// (prod 2026-06-19): a player who RECONNECTS within the grace window (fresh
// socket, connected AFTER their disconnect marker) must not be forfeited just
// because the rejoin handshake hadn't cleared the stale marker when the durable
// forfeit timer fired. They get ONE bounded UI-ready window; only if that also
// lapses with the marker still set do they forfeit (zombie protection).
//
// This must behave IDENTICALLY vs an AI opponent and vs a human opponent — the
// "bot can't win by forfeit" guard is only a safety fallback, not the fix.

const getRedisClientMock = vi.fn();
const getMatchMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const getMatchCacheMock = vi.fn();
const finalizeForfeitMock = vi.fn();
const completeFromProgressMock = vi.fn();
const scheduleTimerMock = vi.fn();
const cancelTimerMock = vi.fn();
const emitRejoinDepsOk = vi.fn();

vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => getRedisClientMock() }));
vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: { getMatch: (...a: unknown[]) => getMatchMock(...a) },
}));
vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: { listMatchPlayers: (...a: unknown[]) => listMatchPlayersMock(...a) },
}));
vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getByIds: vi.fn(async (ids: string[]) =>
      new Map(ids.map((id) => [id, { id, is_ai: id.startsWith('ai'), nickname: id, avatar_url: null, country: 'GE' }]))
    ),
  },
}));
vi.mock('../../src/realtime/match-cache.js', async (i) => {
  const actual = await i<typeof import('../../src/realtime/match-cache.js')>();
  return { ...actual, getMatchCache: (...a: unknown[]) => getMatchCacheMock(...a) };
});
vi.mock('../../src/realtime/possession-match-flow.js', async (i) => {
  const actual = await i<typeof import('../../src/realtime/possession-match-flow.js')>();
  return { ...actual, ensurePossessionActiveTimers: vi.fn(async () => true) };
});
vi.mock('../../src/realtime/possession-completion.js', async (i) => {
  const actual = await i<typeof import('../../src/realtime/possession-completion.js')>();
  return { ...actual, completePossessionMatchFromProgress: (...a: unknown[]) => completeFromProgressMock(...a) };
});
vi.mock('../../src/realtime/services/match-forfeit.service.js', async (i) => {
  const actual = await i<typeof import('../../src/realtime/services/match-forfeit.service.js')>();
  return {
    ...actual,
    finalizeMatchAsForfeit: (...a: unknown[]) => finalizeForfeitMock(...a),
    buildOpponentForfeitPendingPayload: vi.fn(() => ({})),
  };
});
vi.mock('../../src/realtime/services/match-final-results.service.js', async (i) => {
  const actual = await i<typeof import('../../src/realtime/services/match-final-results.service.js')>();
  return { ...actual, buildFinalResultsPayload: vi.fn(async () => null), emitFinalResultsToMatchParticipants: vi.fn() };
});
// Keep the rejoin payload builder cheap and side-effect free.
vi.mock('../../src/realtime/services/match-participants.helpers.js', async (i) => {
  const actual = await i<typeof import('../../src/realtime/services/match-participants.helpers.js')>();
  return { ...actual, getOpponentInfo: vi.fn(async () => null) };
});
vi.mock('../../src/realtime/session-country.js', () => ({
  getCurrentCountriesForUsers: vi.fn(async () => new Map()),
}));
vi.mock('../../src/realtime/realtime-timer-scheduler.js', async (i) => {
  const actual = await i<typeof import('../../src/realtime/realtime-timer-scheduler.js')>();
  return {
    ...actual,
    scheduleRealtimeTimer: (...a: unknown[]) => { scheduleTimerMock(...a); return Promise.resolve(); },
    cancelRealtimeTimer: (...a: unknown[]) => { cancelTimerMock(...a); return Promise.resolve(); },
  };
});

const MARKER_MS = 1_000_000;

// Fake redis backed by a real Map so the grace_extended flag actually persists
// across the two grace fires within a test.
function makeRedis(initial: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    isOpen: true,
    exists: vi.fn(async (k: string) => (store.has(k) ? 1 : 0)),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    del: vi.fn(async (k: string | string[]) => {
      const keys = Array.isArray(k) ? k : [k];
      let n = 0;
      for (const key of keys) if (store.delete(key)) n += 1;
      return n;
    }),
    _store: store,
  };
}

function freshSocket(userId: string) {
  return { data: { user: { id: userId }, connectedAt: MARKER_MS + 5_000 } };
}
function handoffSocket(userId: string) {
  return { data: { user: { id: userId }, connectedAt: MARKER_MS - 7_000 } };
}
function zombieSocket(userId: string) {
  return { data: { user: { id: userId }, connectedAt: MARKER_MS - 100_000 } };
}

function makeIo(
  userRooms: Record<string, Array<{ data: unknown }>>,
  matchRoomSockets: Array<{ data: unknown }> = []
) {
  const emits: Record<string, ReturnType<typeof vi.fn>> = {};
  return {
    io: {
      in: (room: string) => ({
        fetchSockets: async () =>
          room.startsWith('user:') ? userRooms[room.slice('user:'.length)] ?? [] : matchRoomSockets,
      }),
      to: (room: string) => {
        emits[room] ??= vi.fn();
        return { emit: emits[room] };
      },
    } as unknown as QuizballServer,
    emits,
  };
}

function seedRedis(extra: Record<string, string> = {}) {
  return makeRedis({
    'match:grace:m1': String(MARKER_MS),
    'match:pause:m1': String(MARKER_MS),
    'match:disconnect:m1:human-1': String(MARKER_MS),
    ...extra,
  });
}

describe('grace expiry — reconnect-pending deferral (root fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitRejoinDepsOk();
    getMatchMock.mockResolvedValue({
      id: 'm1', mode: 'ranked', status: 'active',
      current_q_index: 8, total_questions: 12, lobby_id: 'l1',
      state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
    });
    getMatchCacheMock.mockResolvedValue(null);
    finalizeForfeitMock.mockResolvedValue({ completed: true, winnerId: null, resultVersion: 1 });
    completeFromProgressMock.mockResolvedValue({ completed: true, winnerId: 'human-1', decisionBasis: 'total_points' });
  });

  for (const opponent of ['ai-bot', 'human-2']) {
    it(`defers (no forfeit) when the human reconnected vs ${opponent}, then nudges rejoin`, async () => {
      const redis = seedRedis();
      getRedisClientMock.mockReturnValue(redis);
      listMatchPlayersMock.mockResolvedValue([
        { user_id: 'human-1', seat: 1 },
        { user_id: opponent, seat: 2 },
      ]);
      // Human reconnected (fresh socket). Opponent present in match too (room not
      // modeled here — opponent absence is irrelevant: the human is the one whose
      // forfeit we must prevent).
      const { io, emits } = makeIo({ 'human-1': [freshSocket('human-1')] });

      const { resolveExpiredGraceWindow } = await import(
        '../../src/realtime/services/match-disconnect.service.js'
      );
      await resolveExpiredGraceWindow(io, 'm1', 'human-1');

      // No terminal resolution of ANY kind — identical vs AI and vs human.
      expect(finalizeForfeitMock).not.toHaveBeenCalled();
      expect(completeFromProgressMock).not.toHaveBeenCalled();
      // Grace preserved + extended flag set + timer re-armed + rejoin nudge sent.
      expect(redis._store.has('match:grace:m1')).toBe(true);
      expect(redis._store.has('match:grace_extended:m1')).toBe(true);
      expect(scheduleTimerMock).toHaveBeenCalledWith(
        'match_disconnect_forfeit', 'm1', expect.any(Date), expect.any(Object)
      );
      expect(emits['user:human-1']).toHaveBeenCalledWith(
        'match:rejoin_available', expect.objectContaining({ matchId: 'm1' })
      );
    });
  }

  it('defers when a replacement socket connected just before the new marker', async () => {
    const redis = seedRedis();
    getRedisClientMock.mockReturnValue(redis);
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'human-1', seat: 1 },
      { user_id: 'human-2', seat: 2 },
    ]);
    // Production sequence: the replacement connected seven seconds before the
    // older socket ping-timed out and wrote the second disconnect marker.
    const { io, emits } = makeIo({
      'human-1': [handoffSocket('human-1')],
      'human-2': [freshSocket('human-2')],
    });

    const { resolveExpiredGraceWindow } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );
    await resolveExpiredGraceWindow(io, 'm1', 'human-1');

    expect(finalizeForfeitMock).not.toHaveBeenCalled();
    expect(redis._store.has('match:grace:m1')).toBe(true);
    expect(redis._store.has('match:pause:m1')).toBe(true);
    expect(redis._store.has('match:grace_extended:m1')).toBe(true);
    expect(emits['user:human-1']).toHaveBeenCalledWith(
      'match:rejoin_available', expect.objectContaining({ matchId: 'm1' })
    );
  });

  it('does NOT defer a zombie socket (connected before the marker) — forfeits immediately', async () => {
    const redis = seedRedis();
    getRedisClientMock.mockReturnValue(redis);
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'human-1', seat: 1 },
      { user_id: 'human-2', seat: 2 },
    ]);
    // u2 present (so the forfeit has a winner); u1 only has a ZOMBIE socket.
    const { io } = makeIo({ 'human-1': [zombieSocket('human-1')], 'human-2': [freshSocket('human-2')] });

    const { resolveExpiredGraceWindow } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );
    await resolveExpiredGraceWindow(io, 'm1', 'human-1');

    // No deferral: the zombie is not a reconnect → straight to terminal forfeit.
    expect(redis._store.has('match:grace_extended:m1')).toBe(false);
    expect(finalizeForfeitMock).toHaveBeenCalledOnce();
  });

  it('forfeits on the SECOND fire when the deferred player never completes rejoin', async () => {
    // grace_extended already set (deferral was granted on a prior fire) and the
    // disconnect marker is still present → the player never rejoined. Forfeit.
    const redis = seedRedis({ 'match:grace_extended:m1': '1' });
    getRedisClientMock.mockReturnValue(redis);
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'human-1', seat: 1 },
      { user_id: 'human-2', seat: 2 },
    ]);
    const { io } = makeIo({ 'human-1': [freshSocket('human-1')], 'human-2': [freshSocket('human-2')] });

    const { resolveExpiredGraceWindow } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );
    await resolveExpiredGraceWindow(io, 'm1', 'human-1');

    // Already extended once → no second deferral; terminal forfeit proceeds.
    expect(finalizeForfeitMock).toHaveBeenCalledOnce();
  });

  it('ignores a late timer after the disconnect episode marker was cleared', async () => {
    const redis = makeRedis({
      'match:grace:m1': String(MARKER_MS),
      'match:pause:m1': String(MARKER_MS),
    });
    getRedisClientMock.mockReturnValue(redis);
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'human-1', seat: 1 },
      { user_id: 'human-2', seat: 2 },
    ]);
    const { io } = makeIo({}, [freshSocket('human-1'), freshSocket('human-2')]);

    const { resolveExpiredGraceWindow } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );
    await resolveExpiredGraceWindow(io, 'm1', 'human-1');

    expect(getMatchMock).not.toHaveBeenCalled();
    expect(finalizeForfeitMock).not.toHaveBeenCalled();
    expect(completeFromProgressMock).not.toHaveBeenCalled();
  });

  it('ignores an old episode timer when the same player has a newer disconnect marker', async () => {
    const newerMarkerMs = MARKER_MS + 30_000;
    const redis = seedRedis({
      'match:disconnect:m1:human-1': String(newerMarkerMs),
    });
    getRedisClientMock.mockReturnValue(redis);
    const { io } = makeIo({});

    const { resolveExpiredGraceWindow } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );
    await resolveExpiredGraceWindow(io, 'm1', 'human-1', MARKER_MS);

    expect(getMatchMock).not.toHaveBeenCalled();
    expect(finalizeForfeitMock).not.toHaveBeenCalled();
    expect(completeFromProgressMock).not.toHaveBeenCalled();
    expect(redis._store.get('match:disconnect:m1:human-1')).toBe(String(newerMarkerMs));
  });

  it('clears stale disconnect state instead of abandoning when both players are live after recent round activity', async () => {
    const redis = seedRedis({ 'match:grace_extended:m1': '1' });
    getRedisClientMock.mockReturnValue(redis);
    getMatchMock.mockResolvedValue({
      id: 'm1', mode: 'ranked', status: 'active',
      current_q_index: 5, total_questions: 12, lobby_id: 'l1',
      updated_at: new Date().toISOString(),
      state_payload: { variant: 'ranked_sim', winnerDecisionMethod: null },
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'human-1', seat: 1 },
      { user_id: 'human-2', seat: 2 },
    ]);
    const liveSockets = [freshSocket('human-1'), freshSocket('human-2')];
    const { io } = makeIo(
      { 'human-1': [liveSockets[0]!], 'human-2': [liveSockets[1]!] },
      liveSockets
    );

    const { resolveExpiredGraceWindow } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );
    await resolveExpiredGraceWindow(io, 'm1', 'human-1');

    expect(finalizeForfeitMock).not.toHaveBeenCalled();
    expect(completeFromProgressMock).not.toHaveBeenCalled();
    expect(redis._store.has('match:disconnect:m1:human-1')).toBe(false);
    expect(redis._store.has('match:grace:m1')).toBe(false);
    expect(redis._store.has('match:pause:m1')).toBe(false);
    expect(cancelTimerMock).toHaveBeenCalledWith('match_disconnect_forfeit', 'm1');
  });
});
