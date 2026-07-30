/**
 * Fixture outcome sampler. Turns two bots' hidden skills (theta on the
 * calibration scale) plus the calibrated params into a plausible, formula-
 * consistent match result: a winner, a decision method, and a scoreline whose
 * margin tracks the skill gap.
 *
 * The head-to-head model is a Bradley-Terry / logistic on the theta gap. The
 * per-question accuracy the calibration fit implies (via difficultyLink at
 * average difficulty, clamped by params.clamps.finalProbCap) sets how sharply
 * the better bot pulls ahead — a large gap yields lopsided scorelines, a small
 * gap yields tight ones and more shootouts. This CONSUMES the zod-validated
 * params so burn-in plausibility is anchored to real Season-1 data.
 */
import type { BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import type { FixtureScore } from './types.js';
import type { Rng } from './rng.js';

const TOTAL_QUESTIONS = 12; // ranked match length (mirrors the live draft)

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Per-question correct probability the calibration implies at AVERAGE question
 * difficulty for a player of skill theta: sigmoid(theta - beta_avg). beta at
 * average difficulty is recovered from the difficultyLink at the cohort-mean
 * accuracy (logit 0 ≈ a 50/50 question), then clamped by finalProbCap.
 */
function perQuestionAccuracy(theta: number, params: BotModelParams): number {
  const betaAvg = params.difficultyLink.intercept; // logit(accuracy)=0 → average question
  const p = sigmoid(theta - betaAvg);
  return Math.min(p, params.clamps.finalProbCap);
}

/** P(A beats B) from the theta gap, scaled by how decisive questions are. */
export function winProbability(thetaA: number, thetaB: number, params: BotModelParams): number {
  // Scale the raw theta gap by the average discrimination so the head-to-head
  // sharpness matches the fitted per-question model rather than an arbitrary
  // logistic temperature.
  const disc = Math.abs(params.difficultyLink.slope); // ~1.48 for S1final
  return sigmoid((thetaA - thetaB) * disc);
}

export interface SimulatedFixture {
  winnerIsA: boolean;
  decision: 'goals' | 'penalty_goals';
  scoreA: FixtureScore;
  scoreB: FixtureScore;
}

/**
 * Sample a full fixture result. `forceWinnerIsA` overrides the coin-flip when
 * the scheduler must assign the winner to respect the hard ceiling (a capped
 * top bot is forced to lose against an equal/stronger neighbor) — the SCORELINE
 * still tracks the skill gap so the forced result stays plausible.
 */
export function simulateFixture(
  thetaA: number,
  thetaB: number,
  params: BotModelParams,
  rng: Rng,
  forceWinnerIsA?: boolean,
): SimulatedFixture {
  const accA = perQuestionAccuracy(thetaA, params);
  const accB = perQuestionAccuracy(thetaB, params);

  // Draw per-question correctness for each side; goals track correct answers
  // (the possession engine converts strong answering into goals). We collapse
  // to a plausible low-integer scoreline rather than simulating the full engine
  // (no match-detail screen exists — verified — so only aggregates are read).
  let correctA = 0;
  let correctB = 0;
  for (let q = 0; q < TOTAL_QUESTIONS; q++) {
    if (rng.bernoulli(accA)) correctA++;
    if (rng.bernoulli(accB)) correctB++;
  }

  // Goals: scale correct-answer lead into a 0-5ish scoreline. A tie on goals
  // forces a shootout (penalty_goals decision).
  const goalsA = Math.max(0, Math.round(correctA / 2.5));
  const goalsB = Math.max(0, Math.round(correctB / 2.5));

  let winnerIsA: boolean;
  let decision: 'goals' | 'penalty_goals';
  let finalGoalsA = goalsA;
  let finalGoalsB = goalsB;
  let penA = 0;
  let penB = 0;

  const wantA = forceWinnerIsA ?? goalsA >= goalsB;

  if (goalsA === goalsB) {
    // Level on goals → shootout decides; scores stay level, penalty tally wins.
    decision = 'penalty_goals';
    winnerIsA = forceWinnerIsA ?? rng.bernoulli(winProbability(thetaA, thetaB, params));
    penA = winnerIsA ? 4 : rng.int(2, 3);
    penB = winnerIsA ? rng.int(2, 3) : 4;
  } else {
    decision = 'goals';
    winnerIsA = wantA;
    // If the natural goal leader contradicts a forced winner, swap the
    // scoreline so goals are consistent with the forced result (winner ahead).
    if (winnerIsA !== goalsA > goalsB) {
      finalGoalsA = winnerIsA ? Math.max(goalsB + 1, goalsA) : Math.min(goalsA, goalsB > 0 ? goalsB - 1 : 0);
      finalGoalsB = winnerIsA ? Math.min(goalsB, finalGoalsA - 1) : Math.max(finalGoalsA + 1, goalsB);
      if (finalGoalsA === finalGoalsB) {
        if (winnerIsA) finalGoalsA++;
        else finalGoalsB++;
      }
    }
  }

  // totalPoints must reflect the FINAL scoreline (a forced-winner swap may have
  // changed the goals above), not the pre-swap goals.
  const totalA = correctA * 100 + finalGoalsA * 20;
  const totalB = correctB * 100 + finalGoalsB * 20;

  return {
    winnerIsA,
    decision,
    scoreA: { goals: finalGoalsA, penaltyGoals: penA, totalPoints: totalA, correctAnswers: correctA },
    scoreB: { goals: finalGoalsB, penaltyGoals: penB, totalPoints: totalB, correctAnswers: correctB },
  };
}
