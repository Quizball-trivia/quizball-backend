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
const completePossessionMatchFromProgressMock = vi.fn();
const resolveMatchPresenceMock = vi.fn();
const abandonMatchWithCompleteLockMock = vi.fn();
const finalizeMatchAsForfeitMock = vi.fn();
const isRankedEarlyForfeitMatchMock = vi.fn();
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

vi.mock('../../src/realtime/possession-completion.js', () => ({
  completePossessionMatchFromProgress: (...a: unknown[]) => completePossessionMatchFromProgressMock(...a),
}));

vi.mock('../../src/realtime/services/match-presence.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/services/match-presence.service.js')>();
  return { ...actual, resolveMatchPresence: (...a: unknown[]) => resolveMatchPresenceMock(...a) };
});

vi.mock('../../src/realtime/services/match-terminal.service.js', () => ({
  abandonMatchWithCompleteLock: (...a: unknown[]) => abandonMatchWithCompleteLockMock(...a),
}));

vi.mock('../../src/realtime/services/match-forfeit.service.js', () => ({
  finalizeMatchAsForfeit: (...a: unknown[]) => finalizeMatchAsForfeitMock(...a),
  isRankedEarlyForfeitMatch: (...a: unknown[]) => isRankedEarlyForfeitMatchMock(...a),
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

// Build a presence resolution with the playerStates the real resolver returns,
// so the AI-forfeit guard (canForfeitToPresentPlayers, which reads the per-player
// `'ai'` reason) sees the same shape it does in production. `aiUserIds` marks
// which present players are AI bots.
function presenceFor(
  present: MatchPlayerRow[],
  absent: MatchPlayerRow[],
  aiUserIds: string[] = []
) {
  const ai = new Set(aiUserIds);
  const playerStates = [
    ...present.map((p) => ({
      player: p,
      userId: p.user_id,
      present: true,
      absent: false,
      reasons: ai.has(p.user_id) ? ['ai'] : ['room_socket'],
    })),
    ...absent.map((p) => ({
      player: p,
      userId: p.user_id,
      present: false,
      absent: true,
      reasons: ['disconnect_key'],
    })),
  ];
  return {
    playerStates,
    presentPlayers: present,
    absentPlayers: absent,
    roomSocketUserIds: present.filter((p) => !ai.has(p.user_id)).map((p) => p.user_id),
    presenceKeyUserIds: [],
    disconnectKeyUserIds: absent.map((p) => p.user_id),
    exitPendingUserIds: [],
    matchSocketCount: present.length,
  };
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
  abandonMatchWithCompleteLockMock.mockResolvedValue({ abandoned: true });
  resolveMatchVariantMock.mockReturnValue('ranked_sim');
  deleteMatchCacheMock.mockResolvedValue(undefined);
  completePossessionMatchFromProgressMock.mockResolvedValue({
    matchId: 'match-1',
    winnerId: null,
    resultVersion: 1,
    completed: false,
    reason: 'undecidable',
  });
  resolveMatchPresenceMock.mockResolvedValue(presenceFor([], []));
  finalizeMatchAsForfeitMock.mockResolvedValue({ matchId: 'match-1', winnerId: 'ai-1', resultVersion: 1, completed: true });
  isRankedEarlyForfeitMatchMock.mockImplementation(
    (activeMatch: MatchRow) => activeMatch.mode === 'ranked' && activeMatch.current_q_index < 2
  );
  buildFinalResultsPayloadMock.mockResolvedValue({ some: 'payload' });
  emitFinalResultsMock.mockResolvedValue(undefined);
});

describe('stale-match-sweeper', () => {
  it('does nothing when there are no stale matches', async () => {
    listStaleActiveMatchesMock.mockResolvedValue([]);
    await runSweep(io);
    expect(getMatchMock).not.toHaveBeenCalled();
    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(abandonMatchWithCompleteLockMock).not.toHaveBeenCalled();
  });

  it('no-ops entirely when the updated_at trigger is missing (never queries for stale matches)', async () => {
    hasUpdatedAtTriggerMock.mockResolvedValue(false);
    await runSweep(io);
    // Must not even query — updated_at is untrustworthy without the trigger.
    expect(listStaleActiveMatchesMock).not.toHaveBeenCalled();
    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(abandonMatchWithCompleteLockMock).not.toHaveBeenCalled();
  });

  it('checks presence FIRST and only completes from progress when no single absent loser exists', async () => {
    // Forfeit-first parity with the live disconnect path (#72): presence must
    // be consulted before any progress-based decision so a disconnector ahead
    // on points can never win via the sweeper.
    const stale = match();
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(stale);
    listMatchPlayersMock.mockResolvedValue([player('u1', 1), player('u2', 2)]);
    // Presence cannot isolate one absent loser (both absent) → progress fallback.
    resolveMatchPresenceMock.mockResolvedValue(
      presenceFor([], [player('u1', 1), player('u2', 2)])
    );
    completePossessionMatchFromProgressMock.mockResolvedValue({
      matchId: 'match-1',
      winnerId: 'u1',
      resultVersion: 1,
      completed: true,
      decisionBasis: 'goals',
    });

    await runSweep(io);

    expect(resolveMatchPresenceMock).toHaveBeenCalledWith(
      io,
      'match-1',
      expect.anything(),
      expect.objectContaining({ staleCleanup: true, includeUserRoomSockets: true })
    );
    expect(resolveMatchPresenceMock.mock.invocationCallOrder[0]).toBeLessThan(
      completePossessionMatchFromProgressMock.mock.invocationCallOrder[0]
    );
    expect(completePossessionMatchFromProgressMock).toHaveBeenCalledWith(io, 'match-1', 'stale_match_sweeper');
    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(abandonMatchWithCompleteLockMock).not.toHaveBeenCalled();
  });

  it('forfeits the absent player WITHOUT consulting progress, even when progress could decide', async () => {
    const stale = match();
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(stale);
    listMatchPlayersMock.mockResolvedValue([player('human-1', 1), player('human-2', 2)]);
    resolveMatchPresenceMock.mockResolvedValue(
      presenceFor([player('human-2', 2)], [player('human-1', 1)])
    );
    // Progress WOULD pick the absent points-leader — it must never be asked.
    completePossessionMatchFromProgressMock.mockResolvedValue({
      matchId: 'match-1',
      winnerId: 'human-1',
      resultVersion: 1,
      completed: true,
      decisionBasis: 'total_points',
    });

    await runSweep(io);

    expect(finalizeMatchAsForfeitMock).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 'match-1', forfeitingUserId: 'human-1' })
    );
    expect(completePossessionMatchFromProgressMock).not.toHaveBeenCalled();
  });

  it('does NOT forfeit the absent human to a present AI — completes from progress instead', async () => {
    // The bot is synthetically "present" but cannot win by forfeit over a human
    // who merely dropped. Resolve from progress (the human's lead) instead of
    // gifting the bot the match. Regression: Thenotorious vs qartlosii 2026-06-19.
    const stale = match({ current_q_index: 5 });
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(stale);
    listMatchPlayersMock.mockResolvedValue([player('human-1', 1), player('ai-1', 2)]);
    resolveMatchPresenceMock.mockResolvedValue(
      presenceFor([player('ai-1', 2)], [player('human-1', 1)], ['ai-1'])
    );
    completePossessionMatchFromProgressMock.mockResolvedValue({
      matchId: 'match-1',
      winnerId: 'human-1',
      resultVersion: 1,
      completed: true,
      decisionBasis: 'total_points',
    });

    await runSweep(io);

    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(completePossessionMatchFromProgressMock).toHaveBeenCalledTimes(1);
    expect(abandonMatchWithCompleteLockMock).not.toHaveBeenCalled();
  });

  it('cancels an early ranked human-vs-AI disconnect as a no-contest', async () => {
    const stale = match({ current_q_index: 1 });
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(stale);
    listMatchPlayersMock.mockResolvedValue([player('human-1', 1), player('ai-1', 2)]);
    resolveMatchPresenceMock.mockResolvedValue(
      presenceFor([player('ai-1', 2)], [player('human-1', 1)], ['ai-1'])
    );
    finalizeMatchAsForfeitMock.mockResolvedValue({
      matchId: 'match-1',
      winnerId: null,
      resultVersion: 1,
      completed: true,
      cancelledNoContest: true,
    });

    await runSweep(io);

    expect(finalizeMatchAsForfeitMock).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 'match-1', forfeitingUserId: 'human-1' })
    );
    expect(completePossessionMatchFromProgressMock).not.toHaveBeenCalled();
    expect(abandonMatchWithCompleteLockMock).not.toHaveBeenCalled();
  });

  it('abandons the match when no player is present (both humans gone)', async () => {
    const stale = match({ mode: 'friendly' });
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(stale);
    listMatchPlayersMock.mockResolvedValue([player('human-1', 1), player('human-2', 2)]);
    resolveMatchPresenceMock.mockResolvedValue(
      presenceFor([], [player('human-1', 1), player('human-2', 2)])
    );

    await runSweep(io);

    expect(abandonMatchWithCompleteLockMock).toHaveBeenCalledWith('match-1');
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
    expect(abandonMatchWithCompleteLockMock).not.toHaveBeenCalled();
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
    await runSweep(io);

    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(abandonMatchWithCompleteLockMock).toHaveBeenCalledWith('match-1');
  });

  it('abandons (does not forfeit) when every player is still present', async () => {
    const stale = match();
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(stale);
    listMatchPlayersMock.mockResolvedValue([player('u1', 1), player('u2', 2)]);
    resolveMatchPresenceMock.mockResolvedValue(
      presenceFor([player('u1', 1), player('u2', 2)], [])
    );

    await runSweep(io);

    expect(finalizeMatchAsForfeitMock).not.toHaveBeenCalled();
    expect(abandonMatchWithCompleteLockMock).toHaveBeenCalledWith('match-1');
  });

  it('leaves the match untouched when forfeit finalization is locked (completed=false)', async () => {
    const stale = match();
    listStaleActiveMatchesMock.mockResolvedValue([stale]);
    getMatchMock.mockResolvedValue(stale);
    listMatchPlayersMock.mockResolvedValue([player('human-1', 1), player('human-2', 2)]);
    resolveMatchPresenceMock.mockResolvedValue(
      presenceFor([player('human-2', 2)], [player('human-1', 1)])
    );
    finalizeMatchAsForfeitMock.mockResolvedValue({ matchId: 'match-1', winnerId: null, resultVersion: 1, completed: false });

    await runSweep(io);

    expect(finalizeMatchAsForfeitMock).toHaveBeenCalledTimes(1);
    // Lock contention / already resolved → do not abandon, do not emit results.
    expect(abandonMatchWithCompleteLockMock).not.toHaveBeenCalled();
    expect(emitFinalResultsMock).not.toHaveBeenCalled();
  });
});
