import { logger } from '../core/logger.js';
import { clueGuessEvaluationsRepo } from '../modules/matches/clue-guess-evaluations.repo.js';
import { explainClueGuess, normalizeAnswer } from './possession-answer-matching.js';

/**
 * Forensic capture for free-text clue ("who am I") guesses.
 *
 * Exists because the "correct answers marked WRONG" reports cannot be diagnosed
 * from what we persist today: `match_answers` keeps only the boolean verdict and
 * the debug logs keep only a hash of the guess. This records the raw text, the
 * normalized form, the answer set compared against, and the rule that
 * matched/failed.
 *
 * Never influences the verdict. The verdict is computed by `fuzzyMatchesAnswer`
 * before this runs and is passed in as `isCorrect`; this module only describes
 * it. Callers invoke it through `fireAndForget`.
 */

/**
 * Rejects are the signal, so every reject is captured. Accepts are captured at
 * this rate purely as a control group for comparison (e.g. proving a rule fires
 * normally for other players on the same question).
 */
const ACCEPT_SAMPLE_RATE = 0.1;

export function shouldCaptureAccept(random: number = Math.random()): boolean {
  return random < ACCEPT_SAMPLE_RATE;
}

export interface CaptureClueGuessInput {
  matchId: string;
  userId: string;
  qIndex: number;
  questionId: string | null;
  /**
   * The guess as the matcher received it. `matchCluesAnswerSchema` applies
   * `z.string().trim()`, so outer whitespace is already gone by the time any
   * handler sees this — it is the exact string that was evaluated, which is
   * what the verdict must be explained against. Interior spacing, case and
   * punctuation are preserved verbatim.
   */
  guess: string;
  acceptedAnswers: string[];
  isCorrect: boolean;
  giveUp: boolean;
  timeMs: number | null;
  clueIndex: number | null;
  isAi: boolean;
  /**
   * Which matcher produced isCorrect. When v2 scored, the stored matchRule /
   * rejectReason must describe the v2 verdict — otherwise a v1-rules
   * explanation contradicts the row (e.g. a guard-rejected "de" would read
   * matchRule=wholeWord with isCorrect=false).
   */
  scoringMatcher?: 'v1' | 'v2';
  /** v2 match kind when v2 scored the guess correct; null when it rejected. */
  v2MatchKind?: string | null;
  /** Injectable for deterministic tests. */
  random?: number;
}

/**
 * Returns true when a row was written, false when the accept sampler skipped it.
 * Swallows nothing — the caller's `fireAndForget` owns error handling — but a
 * capture failure must never surface to the player.
 */
export async function captureClueGuessEvaluation(input: CaptureClueGuessInput): Promise<boolean> {
  // A give-up carries no guess text to diagnose; skip it rather than storing
  // empty rows that dilute the reject population.
  if (input.giveUp) return false;
  if (!input.isCorrect || shouldCaptureAccept(input.random)) {
    const explanation = explainClueGuess(input.guess, input.acceptedAnswers);
    const v2Scored = input.scoringMatcher === 'v2';
    const matchRule = v2Scored
      ? (input.isCorrect ? `v2:${input.v2MatchKind ?? 'unknown'}` : null)
      : explanation.matchedRule;
    const rejectReason = v2Scored
      ? (input.isCorrect ? null : (explanation.rejectReason ?? 'v2:no-match'))
      : explanation.rejectReason;

    await clueGuessEvaluationsRepo.insert({
      matchId: input.matchId,
      userId: input.userId,
      qIndex: input.qIndex,
      questionId: input.questionId,
      rawGuess: input.guess,
      normalizedGuess: explanation.normalizedGuess,
      acceptedAnswers: input.acceptedAnswers,
      normalizedAcceptedAnswers: input.acceptedAnswers.map((answer) => normalizeAnswer(answer)),
      isCorrect: input.isCorrect,
      giveUp: input.giveUp,
      matchRule,
      matchDistance: explanation.matchDistance,
      rejectReason,
      candidateDetail: explanation.candidates,
      timeMs: input.timeMs,
      clueIndex: input.clueIndex,
      isAi: input.isAi,
      captureMode: input.isCorrect ? 'sampled' : 'full',
    });

    // Surfaces the disagreement class we are hunting: the matcher said WRONG but
    // an accepted answer was an exact normalized match. Warn-level so it is
    // visible in prod logs without turning on debug.
    if (!input.isCorrect && explanation.candidates.some((c) => c.normalizedAccepted === explanation.normalizedGuess)) {
      logger.warn(
        {
          eventName: 'clue_guess_capture',
          matchId: input.matchId,
          qIndex: input.qIndex,
          userId: input.userId,
          questionId: input.questionId,
          rejectReason: explanation.rejectReason,
        },
        'Clue guess rejected despite an exact normalized match in the accepted set'
      );
    }
    return true;
  }
  return false;
}
