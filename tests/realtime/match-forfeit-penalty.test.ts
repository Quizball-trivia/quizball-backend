import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PossessionStatePayload } from '../../src/modules/matches/matches.service.js';

// Tests the early-forfeit abuse penalty in finalizeMatchAsForfeit:
//   - First 3 early-forfeits in a 24h window → free (ticket refunded, no RP)
//   - 4th+ early-forfeit → forfeiter penalized (100 RP deducted, NO ticket
//     refund for the forfeiter; opponent still gets their ticket back).

const acquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const startLockHeartbeatMock = vi.fn();
const getMatchMock = vi.fn();
const setMatchStatePayloadMock = vi.fn();
const abandonMatchMock = vi.fn();
const completeMatchMock = vi.fn();
const computeAvgTimesMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const setPlayerFinalTotalsMock = vi.fn();
const updatePlayerAvgTimeMock = vi.fn();
const getByIdsMock = vi.fn();
const bumpEarlyForfeitCountMock = vi.fn();
const applyEarlyForfeitRpPenaltyMock = vi.fn();
const settleCompletedRankedMatchMock = vi.fn();
const refundRankedTicketsMock = vi.fn();
const deleteMatchCacheMock = vi.fn();
const getRedisClientMock = vi.fn();
const awardCompletedMatchXpMock = vi.fn();
const evaluateForMatchBestEffortMock = vi.fn();

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: (...a: unknown[]) => acquireLockMock(...a),
  releaseLock: (...a: unknown[]) => releaseLockMock(...a),
  startLockHeartbeat: (...a: unknown[]) => startLockHeartbeatMock(...a),
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...a: unknown[]) => getMatchMock(...a),
    setMatchStatePayload: (...a: unknown[]) => setMatchStatePayloadMock(...a),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', () => ({
  matchesService: {
    abandonMatch: (...a: unknown[]) => abandonMatchMock(...a),
    completeMatch: (...a: unknown[]) => completeMatchMock(...a),
    computeAvgTimes: (...a: unknown[]) => computeAvgTimesMock(...a),
  },
  resolveMatchVariant: () => 'ranked_sim',
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    listMatchPlayers: (...a: unknown[]) => listMatchPlayersMock(...a),
    setPlayerFinalTotals: (...a: unknown[]) => setPlayerFinalTotalsMock(...a),
    updatePlayerAvgTime: (...a: unknown[]) => updatePlayerAvgTimeMock(...a),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getByIds: (...a: unknown[]) => getByIdsMock(...a),
    bumpEarlyForfeitCount: (...a: unknown[]) => bumpEarlyForfeitCountMock(...a),
  },
}));

vi.mock('../../src/modules/ranked/ranked.repo.js', () => ({
  rankedRepo: {
    applyEarlyForfeitRpPenalty: (...a: unknown[]) => applyEarlyForfeitRpPenaltyMock(...a),
  },
}));

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: { settleCompletedRankedMatch: (...a: unknown[]) => settleCompletedRankedMatchMock(...a) },
}));

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: { refundRankedTickets: (...a: unknown[]) => refundRankedTicketsMock(...a) },
}));

vi.mock('../../src/realtime/match-cache.js', () => ({
  deleteMatchCache: (...a: unknown[]) => deleteMatchCacheMock(...a),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => getRedisClientMock(),
}));

vi.mock('../../src/realtime/match-flow.js', () => ({
  cancelMatchQuestionTimer: vi.fn(),
}));

vi.mock('../../src/realtime/possession-match-flow.js', () => ({
  cancelPossessionHalftimeTimer: vi.fn(),
}));

vi.mock('../../src/realtime/match-keys.js', () => ({
  lastMatchKey: () => 'last-match:key',
  matchDisconnectKey: () => 'dc:key',
  matchExitPendingKey: () => 'exit:key',
  matchForfeitPendingUserKey: () => 'fp:key',
  matchGraceKey: () => 'grace:key',
  matchPauseKey: () => 'pause:key',
  matchPresenceKey: () => 'presence:key',
  matchReconnectCountKey: () => 'rc:key',
}));

vi.mock('../../src/realtime/ai-ranked.constants.js', () => ({
  rankedAiMatchKey: () => 'ai:key',
}));

vi.mock('../../src/realtime/match-utils.js', () => ({
  buildStandings: () => [],
}));

vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: { suppressPendingForfeit: vi.fn() },
}));

vi.mock('../../src/realtime/services/match-participants.helpers.js', () => ({
  getParticipantSnapshot: vi.fn(),
}));

vi.mock('../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalResultsPayload: vi.fn(),
  emitFinalResultsToMatchParticipants: vi.fn(),
}));

vi.mock('../../src/realtime/services/match-entry.service.js', () => ({
  resolveMatchReplayEvidence: vi.fn(),
}));

vi.mock('../../src/realtime/services/party-quiz-dropout.service.js', () => ({
  applyPartyQuizDropouts: vi.fn(),
}));

vi.mock('../../src/realtime/services/match-excused-exit.service.js', () => ({
  findOpponentInDisconnectGrace: vi.fn(),
  markExcusedExitPending: vi.fn(),
}));

vi.mock('../../src/modules/objectives/index.js', () => ({
  objectivesService: { evaluateForMatchBestEffort: (...a: unknown[]) => evaluateForMatchBestEffortMock(...a) },
}));

vi.mock('../../src/modules/progression/progression.service.js', () => ({
  progressionService: { awardCompletedMatchXp: (...a: unknown[]) => awardCompletedMatchXpMock(...a) },
}));

const FORFEITER_ID = 'forfeiter-uuid';
const OPPONENT_ID = 'opponent-uuid';
const MATCH_ID = 'match-uuid';

function setupActiveRankedMatch(roundsPlayed: number) {
  getMatchMock.mockResolvedValue({
    id: MATCH_ID,
    mode: 'ranked',
    status: 'active',
    state_payload: { variant: 'ranked_sim' },
    current_q_index: roundsPlayed,
  });
  setMatchStatePayloadMock.mockResolvedValue(undefined);
  abandonMatchMock.mockResolvedValue(undefined);
  completeMatchMock.mockResolvedValue(undefined);
  computeAvgTimesMock.mockResolvedValue(new Map());
  setPlayerFinalTotalsMock.mockResolvedValue(undefined);
  updatePlayerAvgTimeMock.mockResolvedValue(undefined);
  settleCompletedRankedMatchMock.mockResolvedValue(null);
  awardCompletedMatchXpMock.mockResolvedValue(undefined);
  evaluateForMatchBestEffortMock.mockResolvedValue(undefined);
  deleteMatchCacheMock.mockResolvedValue(undefined);
  listMatchPlayersMock.mockResolvedValue([
    { user_id: FORFEITER_ID },
    { user_id: OPPONENT_ID },
  ]);
  getByIdsMock.mockResolvedValue(
    new Map([
      [FORFEITER_ID, { id: FORFEITER_ID, is_ai: false }],
      [OPPONENT_ID, { id: OPPONENT_ID, is_ai: false }],
    ])
  );
  refundRankedTicketsMock.mockResolvedValue({ wallets: {} });
  applyEarlyForfeitRpPenaltyMock.mockResolvedValue({ oldRp: 5000, newRp: 4900 });
  getRedisClientMock.mockReturnValue(null);
}

describe('finalizeMatchAsForfeit — early-forfeit abuse penalty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireLockMock.mockResolvedValue({ acquired: true, token: 'lock-token' });
    releaseLockMock.mockResolvedValue(undefined);
    startLockHeartbeatMock.mockReturnValue({ stop: vi.fn() });
    setupActiveRankedMatch(0);
  });

  it('persists the frozen score before ranked settlement on late forfeits', async () => {
    setupActiveRankedMatch(3);
    listMatchPlayersMock.mockResolvedValue([
      { match_id: MATCH_ID, user_id: FORFEITER_ID, seat: 1, total_points: 100, correct_answers: 1, goals: 0, penalty_goals: 0, avg_time_ms: null },
      { match_id: MATCH_ID, user_id: OPPONENT_ID, seat: 2, total_points: 220, correct_answers: 4, goals: 2, penalty_goals: 0, avg_time_ms: null },
    ]);

    const statePayload: PossessionStatePayload = {
      version: 1,
      variant: 'ranked_sim',
      phase: 'NORMAL_PLAY',
      half: 1,
      possessionDiff: 0,
      kickOffSeat: 1,
      speedStreakHolderSeat: null,
      speedStreakCandidateSeat: null,
      speedStreakCandidateCount: 0,
      goals: { seat1: 0, seat2: 3 },
      penaltyGoals: { seat1: 0, seat2: 0 },
      normalQuestionsPerHalf: 6,
      normalQuestionsAnsweredInHalf: 3,
      normalQuestionsAnsweredTotal: 3,
      lastAttack: { attackerSeat: null },
      halftime: {
        deadlineAt: null,
        uiReadyAt: null,
        readyDeferCount: 0,
        categoryOptions: [],
        firstHalfShownCategoryIds: [],
        firstBanSeat: null,
        bans: { seat1: null, seat2: null },
        purpose: 'second_half',
      },
      penalty: {
        round: 0,
        shooterSeat: 1,
        suddenDeath: false,
        kicksTaken: { seat1: 0, seat2: 0 },
      },
      penaltyCategoryId: null,
      imageMcq: {},
      currentQuestion: null,
      winnerDecisionMethod: null,
      stateVersionCounter: 0,
    };

    const { finalizeMatchAsForfeit } = await import('../../src/realtime/services/match-forfeit.service.js');

    await finalizeMatchAsForfeit({
      matchId: MATCH_ID,
      forfeitingUserId: FORFEITER_ID,
      cacheSnapshot: {
        matchId: MATCH_ID,
        status: 'active',
        mode: 'ranked',
        totalQuestions: 12,
        categoryAId: 'cat-a',
        categoryBId: 'cat-b',
        startedAt: new Date().toISOString(),
        players: [
          { userId: FORFEITER_ID, seat: 1, totalPoints: 100, correctAnswers: 1, goals: 0, penaltyGoals: 0, avgTimeMs: null },
          { userId: OPPONENT_ID, seat: 2, totalPoints: 240, correctAnswers: 5, goals: 3, penaltyGoals: 0, avgTimeMs: null },
        ],
        currentQIndex: 3,
        statePayload,
        currentQuestion: null,
        answers: {},
        clueReveals: {},
      },
    });

    expect(setPlayerFinalTotalsMock).toHaveBeenCalledWith(
      MATCH_ID,
      OPPONENT_ID,
      expect.objectContaining({ totalPoints: 240, correctAnswers: 5, goals: 3, penaltyGoals: 0 })
    );
    expect(setPlayerFinalTotalsMock).toHaveBeenCalledWith(
      MATCH_ID,
      FORFEITER_ID,
      expect.objectContaining({ goals: 0, penaltyGoals: 0 })
    );
    const lastTotalsWriteOrder = Math.max(...setPlayerFinalTotalsMock.mock.invocationCallOrder);
    expect(lastTotalsWriteOrder).toBeLessThan(settleCompletedRankedMatchMock.mock.invocationCallOrder[0]!);
    expect(settleCompletedRankedMatchMock).toHaveBeenCalledWith(MATCH_ID);
  });

  it('refunds both players and does NOT penalize on the 1st early-forfeit', async () => {
    bumpEarlyForfeitCountMock.mockResolvedValue(1);

    const { finalizeMatchAsForfeit } = await import('../../src/realtime/services/match-forfeit.service.js');

    const result = await finalizeMatchAsForfeit({
      matchId: MATCH_ID,
      forfeitingUserId: FORFEITER_ID,
    });

    expect(result.cancelledNoContest).toBe(true);
    expect(bumpEarlyForfeitCountMock).toHaveBeenCalledWith(FORFEITER_ID, MATCH_ID);
    expect(applyEarlyForfeitRpPenaltyMock).not.toHaveBeenCalled();
    expect(refundRankedTicketsMock).toHaveBeenCalledTimes(1);
    expect(refundRankedTicketsMock).toHaveBeenCalledWith([FORFEITER_ID, OPPONENT_ID]);
  });

  it('refunds both players and does NOT penalize on the 3rd early-forfeit', async () => {
    bumpEarlyForfeitCountMock.mockResolvedValue(3);

    const { finalizeMatchAsForfeit } = await import('../../src/realtime/services/match-forfeit.service.js');

    const result = await finalizeMatchAsForfeit({
      matchId: MATCH_ID,
      forfeitingUserId: FORFEITER_ID,
    });

    expect(result.cancelledNoContest).toBe(true);
    expect(applyEarlyForfeitRpPenaltyMock).not.toHaveBeenCalled();
    expect(refundRankedTicketsMock).toHaveBeenCalledTimes(1);
    expect(refundRankedTicketsMock).toHaveBeenCalledWith([FORFEITER_ID, OPPONENT_ID]);
  });

  it('penalizes the forfeiter on the 4th early-forfeit: deducts RP, skips ticket refund', async () => {
    bumpEarlyForfeitCountMock.mockResolvedValue(4);

    const { finalizeMatchAsForfeit } = await import('../../src/realtime/services/match-forfeit.service.js');

    const result = await finalizeMatchAsForfeit({
      matchId: MATCH_ID,
      forfeitingUserId: FORFEITER_ID,
    });

    expect(result.cancelledNoContest).toBe(true);
    expect(applyEarlyForfeitRpPenaltyMock).toHaveBeenCalledWith(
      FORFEITER_ID,
      MATCH_ID,
      100
    );
    // Forfeiter excluded from refund — only the opponent gets their ticket back.
    expect(refundRankedTicketsMock).toHaveBeenCalledTimes(1);
    expect(refundRankedTicketsMock).toHaveBeenCalledWith([OPPONENT_ID]);
  });

  it('penalizes the forfeiter on every early-forfeit beyond the 4th', async () => {
    bumpEarlyForfeitCountMock.mockResolvedValue(7);

    const { finalizeMatchAsForfeit } = await import('../../src/realtime/services/match-forfeit.service.js');

    await finalizeMatchAsForfeit({
      matchId: MATCH_ID,
      forfeitingUserId: FORFEITER_ID,
    });

    expect(applyEarlyForfeitRpPenaltyMock).toHaveBeenCalledWith(
      FORFEITER_ID,
      MATCH_ID,
      100
    );
    expect(refundRankedTicketsMock).toHaveBeenCalledTimes(1);
    expect(refundRankedTicketsMock).toHaveBeenCalledWith([OPPONENT_ID]);
  });

  it('still refunds both players when the penalty returns null (no ranked profile)', async () => {
    bumpEarlyForfeitCountMock.mockResolvedValue(5);
    applyEarlyForfeitRpPenaltyMock.mockResolvedValue(null);

    const { finalizeMatchAsForfeit } = await import('../../src/realtime/services/match-forfeit.service.js');

    await finalizeMatchAsForfeit({
      matchId: MATCH_ID,
      forfeitingUserId: FORFEITER_ID,
    });

    // Penalty attempted exactly once but nothing deducted (no profile) — forfeiter still refunded.
    expect(applyEarlyForfeitRpPenaltyMock).toHaveBeenCalledTimes(1);
    expect(applyEarlyForfeitRpPenaltyMock).toHaveBeenCalledWith(
      FORFEITER_ID,
      MATCH_ID,
      100
    );
    expect(refundRankedTicketsMock).toHaveBeenCalledTimes(1);
    expect(refundRankedTicketsMock).toHaveBeenCalledWith([FORFEITER_ID, OPPONENT_ID]);
  });

  it('still refunds both players when the penalty call throws', async () => {
    bumpEarlyForfeitCountMock.mockResolvedValue(5);
    applyEarlyForfeitRpPenaltyMock.mockRejectedValue(new Error('DB down'));

    const { finalizeMatchAsForfeit } = await import('../../src/realtime/services/match-forfeit.service.js');

    await finalizeMatchAsForfeit({
      matchId: MATCH_ID,
      forfeitingUserId: FORFEITER_ID,
    });

    expect(applyEarlyForfeitRpPenaltyMock).toHaveBeenCalledTimes(1);
    expect(applyEarlyForfeitRpPenaltyMock).toHaveBeenCalledWith(
      FORFEITER_ID,
      MATCH_ID,
      100
    );
    expect(refundRankedTicketsMock).toHaveBeenCalledTimes(1);
    expect(refundRankedTicketsMock).toHaveBeenCalledWith([FORFEITER_ID, OPPONENT_ID]);
  });

  it('falls back to non-penalized refund if the counter bump throws', async () => {
    bumpEarlyForfeitCountMock.mockRejectedValue(new Error('DB down'));

    const { finalizeMatchAsForfeit } = await import('../../src/realtime/services/match-forfeit.service.js');

    const result = await finalizeMatchAsForfeit({
      matchId: MATCH_ID,
      forfeitingUserId: FORFEITER_ID,
    });

    expect(result.cancelledNoContest).toBe(true);
    expect(applyEarlyForfeitRpPenaltyMock).not.toHaveBeenCalled();
    // Both players refunded as a safe fallback.
    expect(refundRankedTicketsMock).toHaveBeenCalledTimes(1);
    expect(refundRankedTicketsMock).toHaveBeenCalledWith([FORFEITER_ID, OPPONENT_ID]);
  });

});
