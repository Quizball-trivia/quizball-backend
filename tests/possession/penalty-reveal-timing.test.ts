import { describe, expect, it } from 'vitest';
import {
  FRONTEND_REVEAL_MS,
  FRONTEND_RESULT_HOLD_MS,
  FRONTEND_TRANSITION_DELAY_MS,
  getQuestionPreAnswerDelayMs,
} from '../../src/realtime/possession-state.js';

// Reproduces the erratic penalty read-window bug (player report: "on the first
// question the answers appeared instantly, on the 2nd — late; you need time to
// read the question"). The pre-answer delay for penalty rounds depended on
// which dispatch path fired — the ready-ack race (reveal only, 3s) vs the
// generic hold+transition+reveal path (6s), plus a special-question surcharge
// when the last regulation question happened to be a special. The fix gives
// penalty rounds ONE fixed pre-answer delay, no matter how they were
// dispatched or what preceded them.

const midMatchState = { half: 2 as const, normalQuestionsAnsweredInHalf: 6 };

function penaltyDelay(overrides: Partial<Parameters<typeof getQuestionPreAnswerDelayMs>[0]> = {}) {
  return getQuestionPreAnswerDelayMs({
    qIndex: 12,
    state: midMatchState,
    phaseKind: 'penalty',
    ...overrides,
  });
}

describe('penalty pre-answer delay is deterministic', () => {
  // 2026-08-30 revision: penalty rounds now dispatch through the ready-ack
  // gate (like goal rounds), because the client's post-kick choreography is
  // long and VARIABLE — a single fixed window gave fast, high-scoring players
  // zero visible read time (the animations swallowed it; player report).
  // Determinism now means: a fixed READ window anchored to the moment the
  // client said its animations finished — not a fixed clock from dispatch.
  it('gives exactly the reveal window after a ready ack, and the full fixed window without one', () => {
    expect(penaltyDelay({ postReadyAck: true })).toBe(FRONTEND_REVEAL_MS);
    expect(penaltyDelay({ postReadyAck: false })).toBe(
      FRONTEND_RESULT_HOLD_MS + FRONTEND_TRANSITION_DELAY_MS + FRONTEND_REVEAL_MS,
    );
  });

  it('is unaffected by the previous question having been a special (both ack paths)', () => {
    for (const postReadyAck of [true, false]) {
      expect(penaltyDelay({ previousQuestionKind: 'countdown', postReadyAck })).toBe(
        penaltyDelay({ previousQuestionKind: 'multipleChoice', postReadyAck }),
      );
      expect(penaltyDelay({ previousQuestionKind: 'clues', postReadyAck })).toBe(
        penaltyDelay({ previousQuestionKind: 'multipleChoice', postReadyAck }),
      );
    }
  });

  it('is identical across regulation and deep sudden-death rounds (both ack paths)', () => {
    expect(penaltyDelay({ qIndex: 12, postReadyAck: true })).toBe(penaltyDelay({ qIndex: 29, postReadyAck: true }));
    expect(penaltyDelay({ qIndex: 12 })).toBe(penaltyDelay({ qIndex: 29 }));
  });

  it('always grants at least the full reveal window as reading time', () => {
    expect(penaltyDelay({ postReadyAck: true })).toBeGreaterThanOrEqual(FRONTEND_REVEAL_MS);
  });

  it('no-ack fallback matches the generic path (hold + transition + reveal), so ceiling-hit pacing is sane', () => {
    expect(penaltyDelay()).toBe(
      FRONTEND_RESULT_HOLD_MS + FRONTEND_TRANSITION_DELAY_MS + FRONTEND_REVEAL_MS,
    );
  });

  it('non-penalty rounds keep their existing path behaviour', () => {
    const generic = getQuestionPreAnswerDelayMs({ qIndex: 5, state: { half: 1, normalQuestionsAnsweredInHalf: 5 } });
    expect(generic).toBe(FRONTEND_RESULT_HOLD_MS + FRONTEND_TRANSITION_DELAY_MS + FRONTEND_REVEAL_MS);
    const ack = getQuestionPreAnswerDelayMs({
      qIndex: 5,
      state: { half: 1, normalQuestionsAnsweredInHalf: 5 },
      postReadyAck: true,
    });
    expect(ack).toBe(FRONTEND_REVEAL_MS);
  });
});
