import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchRow, MatchPlayerRow } from '../../src/modules/matches/matches.types.js';

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const listStaleActiveMatchesMock = vi.fn();
const getMatchMock = vi.fn();
const abandonMatchRepoMock = vi.fn();
const hasUpdatedAtTriggerMock = vi.fn();
const abandonMatchServiceMock = vi.fn();
const resolveMatchVariantMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const getByIdsMock = vi.fn();
const finalizeMatchAsForfeitMock = vi.fn();
const buildFinalResultsPayloadMock = vi.fn();
const emitFinalResultsMock = vi.fn();
const deleteMatchCacheMock = vi.fn();
const acquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const redisExistsMock = vi.fn();
const redisDelMock = vi.fn();

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    listStaleActiveMatches: (...a: unknown[]) => listStaleActiveMatchesMock(...a),
    getMatch: (...a: unknown[]) => getMatchMock(...a),
    abandonMatch: (...a: unknown[]) => abandonMatchRepoMock(...a),
    hasUpdatedAtTrigger: (...a: unknown[]) => hasUpdatedAtTriggerMock(...a),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', () => ({
  matchesService: {
    abandonMatch: (...a: unknown[]) => abandonMatchServiceMock(...a),
  },
  resolveMatchVariant: (...a: unknown[]) => resolveMatchVariantMock(...a),
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    listMatchPlayers: (...a: unknown[]) => listMatchPlayersMock(...a),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: { getByIds: (...a: unknown[]) => getByIdsMock(...a) },
}));

vi.mock('../../src/realtime/services/match-forfeit.service.js', () => ({
  finalizeMatchAsForfeit: (...a: unknown[]) => finalizeMatchAsForfeitMock(...a),
}));

vi.mock('../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalResultsPayload: (...a: unknown[]) => buildFinalResultsPayloadMock(...a),
  emitFinalResultsToMatchParticipants: (...a: unknown[]) => emitFinalResultsMock(...a),
}));

vi.mock('../../src/realtime/match-cache.js', () => ({
  deleteMatchCache: (...a: unknown[]) => deleteMatchCacheMock(...a),
}));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: (...a: unknown[]) => acquireLockMock(...a),
  releaseLock: (...a: unknown[]) => releaseLockMock(...a),
}));

const redisMock = {
  isOpen: true,
  exists: (...a: unknown[]) => redisExistsMock(...a),
  del: (...a: unknown[]) => redisDelMock(...a),
};
vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redisMock,
}));

import { __staleMatchSweeperInternals } from '../../src/realtime/services/stale-match-sweeper.service.js';

const { runSweep, resetTriggerCache } = __staleMatchSweeperInternals;

const io = {} as never;

function match(overrides: Partial<MatchRow> = {}): MatchRow {
  return {
    id: 'match-1',
    lobby_id: 'lobby-1',
    mode: 'ranked',
    status: 'active',
    category_a_id: 'cat-a',
    category_b_id: null,
    current_q_index: 0,
    total_questions: 12,
    started_at: new Date().toISOString(),
    ended_at: null,
    winner_user_id: null,
    updated_at: new Date().toISOString(),
    state_payload: {},
    ranked_context: null,
    is_dev: false,
    ...overrides,
  } as MatchRow;
}

function player(userId: string, seat: number): MatchPlayerRow {
  return {
    match_id: 'match-1',
    user_id: userId,
    seat,
    total_points: 0,
    correct_answers: 0,
    avg_time_ms: null,
    goals: 0,
    penalty_goals: 0,
  } as MatchPlayerRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTriggerCache();
  hasUpdatedAtTriggerMock.mockResolvedValue(true);
  acquireLockMock.mockResolvedValue({ acquired: true, token: 'tok' });
  releaseLockMock.mockResolvedValue(true);
  redisExistsMock.mockResolvedValue(0);
  redisDelMock.mockResolvedValue(1);
  abandonMatchRepoMock.mockResolvedValue(true);
  abandonMatchServiceMock.mockResolvedValue(undefined);
  resolveMatchVariantMock.mockReturnValue('ranked_sim');
  deleteMatchCacheMock.mockResolvedValue(undefined);
  finalizeMatchAsForfeitMock.mockResolvedValue({ matchId: 'match-1', winnerId: 'ai-1', resultVersion: 1, completed: true });
  buildFinalResultsPayloadMock.mockResolvedValue({ some: 'payload' });
  emitFinalResultsMock.mockResolvedValue(undefined);
});

describe('stale-match-sweeper', () => {
  it('does nothing when there are no stale matches', async () => {
    listStaleActiveMatchesMock.mockResolvedValue([]);
    await runSweep(io);
    expect(getMatchMock).not.toHaveBeenCalled();
    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(abandonMatchServiceMock).not.toHaveBeenCalled();
  });

  it('no-ops entirely when the updated_at trigger is missing (never queries for stale matches)', async () => {
    hasUpdatedAtTriggerMock.mockResolvedValue(false);
    await runSweep(io);
    // Must not even query — updated_at is untrustworthy without the trigger.
    expect(listStaleActiveMatchesMock).not.toHaveBeenCalled();
    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(abandonMatchServiceMock).not.toHaveBeenCalled();
  });

  it('forfeits the absent human when an AI counterpart is present', async () => {
    const stale = match();
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(stale);
    listMatchPlayersMock.mockResolvedValue([player('human-1', 1), player('ai-1', 2)]);
    getByIdsMock.mockResolvedValue(
      new Map([
        ['human-1', { id: 'human-1', is_ai: false }],
        ['ai-1', { id: 'ai-1', is_ai: true }],
      ])
    );
    redisExistsMock.mockResolvedValue(0); // human has no presence → absent

    await runSweep(io);

    expect(finalizeMatchAsForfeitMock).toHaveBeenCalledTimes(1);
    expect(finalizeMatchAsForfeitMock).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 'match-1', forfeitingUserId: 'human-1' })
    );
    expect(emitFinalResultsMock).toHaveBeenCalledTimes(1);
    expect(abandonMatchServiceMock).not.toHaveBeenCalled();
  });

  it('abandons the match when no player is present (both humans gone)', async () => {
    const stale = match({ mode: 'friendly' });
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(stale);
    listMatchPlayersMock.mockResolvedValue([player('human-1', 1), player('human-2', 2)]);
    getByIdsMock.mockResolvedValue(
      new Map([
        ['human-1', { id: 'human-1', is_ai: false }],
        ['human-2', { id: 'human-2', is_ai: false }],
      ])
    );
    redisExistsMock.mockResolvedValue(0); // neither present

    await runSweep(io);

    expect(abandonMatchServiceMock).toHaveBeenCalledWith('match-1');
    expect(deleteMatchCacheMock).toHaveBeenCalledWith('match-1');
    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
  });

  it('abandons a playerless dead row', async () => {
    const stale = match({ mode: 'friendly' });
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(stale);
    listMatchPlayersMock.mockResolvedValue([]);

    await runSweep(io);

    expect(abandonMatchRepoMock).toHaveBeenCalledWith('match-1');
    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(abandonMatchServiceMock).not.toHaveBeenCalled();
  });

  it('skips a match that is no longer active when re-fetched under the lock', async () => {
    const stale = match();
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(match({ status: 'completed' }));

    await runSweep(io);

    expect(listMatchPlayersMock).not.toHaveBeenCalled();
    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(abandonMatchServiceMock).not.toHaveBeenCalled();
  });

  it('skips when the per-match lock cannot be acquired (another worker owns it)', async () => {
    const stale = match();
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    acquireLockMock.mockResolvedValue({ acquired: false });

    await runSweep(io);

    expect(getMatchMock).not.toHaveBeenCalled();
    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
  });

  it('abandons a stale party-quiz match instead of forfeiting it', async () => {
    const stale = match({ mode: 'friendly' });
    resolveMatchVariantMock.mockReturnValue('friendly_party_quiz');
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(stale);
    listMatchPlayersMock.mockResolvedValue([
      player('u1', 1), player('u2', 2), player('u3', 3), player('u4', 4),
    ]);
    getByIdsMock.mockResolvedValue(
      new Map([
        ['u1', { id: 'u1', is_ai: false }],
        ['u2', { id: 'u2', is_ai: false }],
        ['u3', { id: 'u3', is_ai: false }],
        ['u4', { id: 'u4', is_ai: false }],
      ])
    );
    redisExistsMock.mockResolvedValue(1); // some present — would otherwise forfeit

    await runSweep(io);

    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(abandonMatchServiceMock).toHaveBeenCalledWith('match-1');
  });

  it('abandons (does not forfeit) when every player is still present', async () => {
    const stale = match();
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(stale);
    listMatchPlayersMock.mockResolvedValue([player('u1', 1), player('u2', 2)]);
    getByIdsMock.mockResolvedValue(
      new Map([
        ['u1', { id: 'u1', is_ai: false }],
        ['u2', { id: 'u2', is_ai: false }],
      ])
    );
    redisExistsMock.mockResolvedValue(1); // both present → no clear absentee

    await runSweep(io);

    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(abandonMatchServiceMock).toHaveBeenCalledWith('match-1');
  });

  it('leaves the match untouched when forfeit finalization is locked (completed=false)', async () => {
    const stale = match();
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(stale);
    listMatchPlayersMock.mockResolvedValue([player('human-1', 1), player('ai-1', 2)]);
    getByIdsMock.mockResolvedValue(
      new Map([
        ['human-1', { id: 'human-1', is_ai: false }],
        ['ai-1', { id: 'ai-1', is_ai: true }],
      ])
    );
    redisExistsMock.mockResolvedValue(0); // human absent → forfeit attempted
    finalizeMatchAsForfeitMock.mockResolvedValue({ matchId: 'match-1', winnerId: null, resultVersion: 1, completed: false });

    await runSweep(io);

    expect(finalizeMatchAsForfeitMock).toHaveBeenCalledTimes(1);
    // Lock contention / already resolved → do not abandon, do not emit results.
    expect(abandonMatchServiceMock).not.toHaveBeenCalled();
    expect(emitFinalResultsMock).not.toHaveBeenCalled();
  });
});
