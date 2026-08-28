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
  it('is identical whether or not the round was dispatched from a ready ack', () => {
    expect(penaltyDelay({ postReadyAck: true })).toBe(penaltyDelay({ postReadyAck: false }));
  });

  it('is unaffected by the previous question having been a special', () => {
    expect(penaltyDelay({ previousQuestionKind: 'countdown' })).toBe(
      penaltyDelay({ previousQuestionKind: 'multipleChoice' }),
    );
    expect(penaltyDelay({ previousQuestionKind: 'clues' })).toBe(
      penaltyDelay({ previousQuestionKind: 'multipleChoice' }),
    );
  });

  it('is identical across regulation and deep sudden-death rounds', () => {
    expect(penaltyDelay({ qIndex: 12 })).toBe(penaltyDelay({ qIndex: 29 }));
  });

  it('always grants at least the full reveal window as reading time', () => {
    expect(penaltyDelay({ postReadyAck: true })).toBeGreaterThanOrEqual(FRONTEND_REVEAL_MS);
  });

  it('matches the pre-fix generic path (hold + transition + reveal), so match pacing is unchanged', () => {
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
