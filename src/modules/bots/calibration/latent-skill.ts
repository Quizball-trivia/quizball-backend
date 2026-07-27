/**
 * Latent-skill estimation from Season-1 Bernoulli answers.
 *
 * Rasch model: P(correct | player p, question q) = sigmoid(theta_p - beta_q),
 * where theta_p is player skill and beta_q is question difficulty. There is NO
 * per-format term: each question has exactly ONE format, so a format offset is
 * perfectly collinear with the beta_q of that format's questions (not
 * identifiable). Per-format bot behaviour comes from the separate per-format
 * models (question_stats.format_stats), not from this scale.
 *
 * Optimizer: coordinate-normalized gradient ascent on the L2-penalized
 * log-likelihood. Each parameter's step divides its summed gradient by that
 * parameter's OWN observation count, so a sparse (100-answer) player and a dense
 * (10k-answer) question both take well-scaled steps regardless of the total row
 * count — this fixes the theta-compression bug where a global 1/N learning rate
 * froze sparse players near zero at production scale. Identifiability is fixed
 * by anchoring mean(theta)=0 each step (the one remaining flat direction:
 * add c to all theta, subtract c from all beta).
 *
 * Convergence is a hard gate: `converged` is true only if the mean absolute
 * per-parameter update fell below `tolerance`. Callers that emit production
 * params MUST refuse to write when this is false.
 */

import { sigmoid } from './math.js';

export interface LatentAnswer {
  playerId: string;
  questionId: string;
  correct: 0 | 1;
}

export interface LatentFitOptions {
  learningRate?: number;
  maxIters?: number;
  /** Convergence threshold on the mean absolute per-parameter update. */
  tolerance?: number;
  /** L2 ridge on theta and beta (keeps sparse players/questions identifiable). */
  ridge?: number;
}

export interface LatentFitResult {
  theta: Map<string, number>;
  beta: Map<string, number>;
  iters: number;
  converged: boolean;
  finalLogLik: number;
  /** Mean-abs per-parameter update on the final iteration (convergence measure). */
  finalUpdateNorm: number;
}

const DEFAULTS: Required<LatentFitOptions> = {
  learningRate: 1.0,
  maxIters: 5000,
  tolerance: 1e-4,
  ridge: 1e-2,
};

export function fitLatentSkill(answers: readonly LatentAnswer[], options: LatentFitOptions = {}): LatentFitResult {
  const opts = { ...DEFAULTS, ...options };
  if (answers.length === 0) throw new Error('fitLatentSkill: no answers');

  const players = [...new Set(answers.map((a) => a.playerId))];
  const questions = [...new Set(answers.map((a) => a.questionId))];

  const theta = new Map<string, number>(players.map((p) => [p, 0]));
  const beta = new Map<string, number>(questions.map((q) => [q, 0]));

  // Per-parameter observation counts for coordinate normalization.
  const nTheta = new Map<string, number>(players.map((p) => [p, 0]));
  const nBeta = new Map<string, number>(questions.map((q) => [q, 0]));
  for (const a of answers) {
    nTheta.set(a.playerId, nTheta.get(a.playerId)! + 1);
    nBeta.set(a.questionId, nBeta.get(a.questionId)! + 1);
  }

  let iter = 0;
  let converged = false;
  let updateNorm = Infinity;

  for (; iter < opts.maxIters; iter += 1) {
    const gTheta = new Map<string, number>(players.map((p) => [p, 0]));
    const gBeta = new Map<string, number>(questions.map((q) => [q, 0]));

    for (const a of answers) {
      const pred = sigmoid(theta.get(a.playerId)! - beta.get(a.questionId)!);
      const err = a.correct - pred; // dLL/dz
      gTheta.set(a.playerId, gTheta.get(a.playerId)! + err);
      gBeta.set(a.questionId, gBeta.get(a.questionId)! - err);
    }

    let sumAbs = 0;
    let count = 0;

    for (const p of players) {
      const n = nTheta.get(p)!;
      // Coordinate-normalized gradient + ridge, divided by this parameter's own
      // observation count (not the global N) so step size is scale-invariant.
      const grad = (gTheta.get(p)! - opts.ridge * theta.get(p)!) / (n + opts.ridge);
      const step = opts.learningRate * grad;
      theta.set(p, theta.get(p)! + step);
      sumAbs += Math.abs(step);
      count += 1;
    }
    for (const q of questions) {
      const n = nBeta.get(q)!;
      const grad = (gBeta.get(q)! - opts.ridge * beta.get(q)!) / (n + opts.ridge);
      const step = opts.learningRate * grad;
      beta.set(q, beta.get(q)! + step);
      sumAbs += Math.abs(step);
      count += 1;
    }

    // Anchor mean(theta)=0 (absorb the constant into beta so predictions are
    // unchanged): subtract mean theta from every theta AND every beta.
    const meanTheta = mean([...theta.values()]);
    for (const p of players) theta.set(p, theta.get(p)! - meanTheta);
    for (const q of questions) beta.set(q, beta.get(q)! - meanTheta);

    updateNorm = count > 0 ? sumAbs / count : 0;
    if (updateNorm < opts.tolerance) {
      converged = true;
      iter += 1;
      break;
    }
  }

  return {
    theta,
    beta,
    iters: iter,
    converged,
    finalLogLik: logLikelihood(answers, theta, beta),
    finalUpdateNorm: updateNorm,
  };
}

export function predictProb(
  fit: Pick<LatentFitResult, 'theta' | 'beta'>,
  answer: Pick<LatentAnswer, 'playerId' | 'questionId'>,
): number {
  const t = fit.theta.get(answer.playerId) ?? 0;
  const b = fit.beta.get(answer.questionId) ?? 0;
  return sigmoid(t - b);
}

function logLikelihood(answers: readonly LatentAnswer[], theta: Map<string, number>, beta: Map<string, number>): number {
  let ll = 0;
  for (const a of answers) {
    const p = sigmoid(theta.get(a.playerId)! - beta.get(a.questionId)!);
    const clamped = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
    ll += a.correct === 1 ? Math.log(clamped) : Math.log(1 - clamped);
  }
  return ll;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}
