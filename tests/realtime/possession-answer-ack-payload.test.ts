import { describe, expect, it } from 'vitest';
import '../setup.js';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { CachedAnswer, MatchCache } from '../../src/realtime/match-cache.js';
import { buildCachedAnswerAckPayload } from '../../src/realtime/possession-payload-mappers.js';
import type { MatchPhaseKind, MatchQuestionKind } from '../../src/realtime/socket.types.js';

// The client fires the opponent "+N" score flight from the answer ack when
// `oppAnswered` is true. `match:opponent_answered` is a room broadcast through
// the Redis adapter with no ordering guarantee against the private ack, and
// the rejoin snapshot never replays it at all — so the ack itself must carry
// the opponent's committed result whenever it reports the opponent answered.

const OPPONENT_FIELDS = ['opponentPointsEarned', 'opponentTotalPoints', 'opponentIsCorrect', 'opponentSelectedIndex'] as const;

function makeAnswer(userId: string, kind: MatchQuestionKind, overrides: Partial<CachedAnswer> = {}): CachedAnswer {
  return {
    userId,
    questionKind: kind,
    selectedIndex: kind === 'multipleChoice' ? 1 : null,
    isCorrect: true,
    timeMs: 1200,
    pointsEarned: 90,
    phaseKind: 'normal',
    phaseRound: 1,
    shooterSeat: null,
    answeredAt: '2026-07-04T12:00:01.000Z',
    ...overrides,
  };
}

function makeCache(
  kind: MatchQuestionKind,
  answers: Record<string, CachedAnswer>,
  phaseKind: MatchPhaseKind = 'normal'
): MatchCache {
  const state = createInitialPossessionState('friendly_possession');
  return {
    matchId: 'match-1',
    status: 'active',
    mode: 'friendly',
    totalQuestions: 12,
    categoryAId: 'cat-a',
    categoryBId: null,
    startedAt: '2026-07-04T11:59:00.000Z',
    players: [
      { userId: 'u1', seat: 1, totalPoints: 190, correctAnswers: 2, goals: 0, penaltyGoals: 0, avgTimeMs: null },
      { userId: 'u2', seat: 2, totalPoints: 170, correctAnswers: 2, goals: 0, penaltyGoals: 0, avgTimeMs: null },
    ],
    currentQIndex: 3,
    statePayload: state,
    currentQuestion: {
      qIndex: 3,
      kind,
      questionId: 'question-1',
      correctIndex: 1,
      phaseKind,
      phaseRound: 1,
      shooterSeat: phaseKind === 'penalty' ? 1 : null,
      attackerSeat: null,
      shownAt: '2026-07-04T12:00:00.000Z',
      deadlineAt: '2026-07-04T12:00:10.000Z',
      questionDTO: { kind: 'multipleChoice', id: 'question-1', prompt: { en: 'Q?' }, options: [], categoryName: { en: 'C' } } as never,
      evaluation: { kind: 'multipleChoice', correctIndex: 1 },
      reveal: { kind: 'multipleChoice', correctIndex: 1 },
    },
    answers,
    revealAcks: {},
    clueReveals: {},
  };
}

function expectNoOpponentFields(ack: unknown): void {
  for (const field of OPPONENT_FIELDS) expect(ack).not.toHaveProperty(field);
}

describe('buildCachedAnswerAckPayload opponent result', () => {
  it('omits the opponent fields while only my answer exists', () => {
    const cache = makeCache('multipleChoice', {
      u1: makeAnswer('u1', 'multipleChoice'),
    });

    const ack = buildCachedAnswerAckPayload(cache, 'u1', { aiUserId: null });

    expect(ack).toMatchObject({ oppAnswered: false, myTotalPoints: 190 });
    expectNoOpponentFields(ack);
  });

  it('carries the opponent MCQ result (total already includes the round) when both answered', () => {
    // MCQ commits bump the cached player's totalPoints at commit time, so the
    // opponent's total is their cached total — exactly what
    // `match:opponent_answered` sends as `opponentTotalPoints`.
    const cache = makeCache('multipleChoice', {
      u1: makeAnswer('u1', 'multipleChoice'),
      u2: makeAnswer('u2', 'multipleChoice', { selectedIndex: 2, isCorrect: false, pointsEarned: 0 }),
    });

    const ack = buildCachedAnswerAckPayload(cache, 'u1', { aiUserId: null });

    expect(ack).toMatchObject({
      oppAnswered: true,
      myTotalPoints: 190,
      opponentPointsEarned: 0,
      opponentTotalPoints: 170,
      opponentIsCorrect: false,
      opponentSelectedIndex: 2,
    });
  });

  it('adds the round points to the opponent total for non-MCQ kinds (mirrors myTotalPoints)', () => {
    const cache = makeCache('putInOrder', {
      u1: makeAnswer('u1', 'putInOrder', { submittedOrderIds: ['a', 'b'] }),
      u2: makeAnswer('u2', 'putInOrder', { pointsEarned: 60, submittedOrderIds: ['b', 'a'] }),
    });

    const ack = buildCachedAnswerAckPayload(cache, 'u1', { aiUserId: null });

    expect(ack).toMatchObject({
      oppAnswered: true,
      myTotalPoints: 190 + 90,
      opponentPointsEarned: 60,
      opponentTotalPoints: 170 + 60,
      opponentIsCorrect: true,
      opponentSelectedIndex: null,
    });
  });

  describe('mirrors the bot broadcast rule (no match:opponent_answered for AI countdown answers)', () => {
    const penaltyAnswer = (userId: string) =>
      makeAnswer(userId, 'multipleChoice', { phaseKind: 'penalty', shooterSeat: 1, pointsEarned: 100 });

    it('carries an AI opponent penalty answer (bots behave like humans in penalties)', () => {
      const cache = makeCache('multipleChoice', { u1: penaltyAnswer('u1'), u2: penaltyAnswer('u2') }, 'penalty');

      expect(buildCachedAnswerAckPayload(cache, 'u1', { aiUserId: 'u2' })).toMatchObject({
        oppAnswered: true,
        opponentPointsEarned: 100,
        opponentTotalPoints: 170,
        opponentIsCorrect: true,
        opponentSelectedIndex: 1,
      });
    });

    it('hides an AI opponent countdown answer', () => {
      const cache = makeCache('countdown', {
        u1: makeAnswer('u1', 'countdown', { foundCount: 4 }),
        u2: makeAnswer('u2', 'countdown', { foundCount: 6, pointsEarned: 60 }),
      });

      const ack = buildCachedAnswerAckPayload(cache, 'u1', { aiUserId: 'u2' });

      expect(ack).toMatchObject({ oppAnswered: true });
      expectNoOpponentFields(ack);
    });

    it('still carries a HUMAN opponent penalty answer (humans broadcast in every phase)', () => {
      const cache = makeCache('multipleChoice', { u1: penaltyAnswer('u1'), u2: penaltyAnswer('u2') }, 'penalty');

      // The AI is me, not the opponent — and a match with no AI at all.
      expect(buildCachedAnswerAckPayload(cache, 'u1', { aiUserId: 'u1' })).toMatchObject({ opponentPointsEarned: 100, opponentTotalPoints: 170 });
      expect(buildCachedAnswerAckPayload(cache, 'u1', { aiUserId: null })).toMatchObject({ opponentPointsEarned: 100, opponentTotalPoints: 170 });
    });

    it('fails closed when the AI lookup is unknown (omits the fields rather than risking a leak)', () => {
      const cache = makeCache('countdown', {
        u1: makeAnswer('u1', 'countdown', { foundCount: 4 }),
        u2: makeAnswer('u2', 'countdown', { foundCount: 6, pointsEarned: 60 }),
      });

      const ack = buildCachedAnswerAckPayload(cache, 'u1', 'unknown');

      expect(ack).toMatchObject({ oppAnswered: true });
      expectNoOpponentFields(ack);
    });

    it('still carries an AI opponent normal-round answer', () => {
      const cache = makeCache('multipleChoice', {
        u1: makeAnswer('u1', 'multipleChoice'),
        u2: makeAnswer('u2', 'multipleChoice', { selectedIndex: 3, isCorrect: false, pointsEarned: 0 }),
      });

      expect(buildCachedAnswerAckPayload(cache, 'u1', { aiUserId: 'u2' })).toMatchObject({
        opponentPointsEarned: 0,
        opponentTotalPoints: 170,
        opponentIsCorrect: false,
        opponentSelectedIndex: 3,
      });
    });
  });
});
