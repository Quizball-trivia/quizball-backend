/**
 * Latent-skill estimation from Season-1 Bernoulli answers.
 *
 * Rasch-style logit: P(correct | player p, question q, format f) =
 *   sigmoid(theta_p - beta_q + gamma_f)
 * where theta_p is player skill, beta_q is question difficulty, gamma_f is a
 * per-format easiness offset (mcq vs true_false vs input_text). We fit by
 * L2-regularized gradient ascent on the log-likelihood, anchoring mean(theta)=0
 * and gamma of the reference format = 0 for identifiability.
 *
 * No external ML dependency — the model is small and convex-ish under ridge, so
 * a few hundred full-batch gradient steps converge reliably. Validated by a
 * synthetic-recovery unit test where the true theta/beta are known.
 */

import { sigmoid } from './math.js';

export interface LatentAnswer {
  playerId: string;
  questionId: string;
  format: string;
  correct: 0 | 1;
}

export interface LatentFitOptions {
  learningRate?: number;
  maxIters?: number;
  tolerance?: number;
  /** L2 ridge on theta and beta (keeps sparse players/questions identifiable). */
  ridge?: number;
  /** L2 ridge on gamma (format offsets, usually well-sampled -> light). */
  gammaRidge?: number;
}

export interface LatentFitResult {
  theta: Map<string, number>;
  beta: Map<string, number>;
  gamma: Map<string, number>;
  referenceFormat: string;
  iters: number;
  converged: boolean;
  finalLogLik: number;
}

const DEFAULTS: Required<LatentFitOptions> = {
  learningRate: 0.5,
  maxIters: 2000,
  tolerance: 1e-6,
  ridge: 1e-3,
  gammaRidge: 1e-4,
};

export function fitLatentSkill(answers: readonly LatentAnswer[], options: LatentFitOptions = {}): LatentFitResult {
  const opts = { ...DEFAULTS, ...options };
  if (answers.length === 0) throw new Error('fitLatentSkill: no answers');

  const players = [...new Set(answers.map((a) => a.playerId))];
  const questions = [...new Set(answers.map((a) => a.questionId))];
  const formats = [...new Set(answers.map((a) => a.format))].sort();
  const referenceFormat = formats[0];

  const theta = new Map<string, number>(players.map((p) => [p, 0]));
  const beta = new Map<string, number>(questions.map((q) => [q, 0]));
  const gamma = new Map<string, number>(formats.map((f) => [f, 0]));

  let prevLL = -Infinity;
  let iter = 0;
  let converged = false;

  for (; iter < opts.maxIters; iter += 1) {
    const gTheta = new Map<string, number>(players.map((p) => [p, 0]));
    const gBeta = new Map<string, number>(questions.map((q) => [q, 0]));
    const gGamma = new Map<string, number>(formats.map((f) => [f, 0]));

    for (const a of answers) {
      const t = theta.get(a.playerId)!;
      const b = beta.get(a.questionId)!;
      const g = gamma.get(a.format)!;
      const pred = sigmoid(t - b + g);
      const err = a.correct - pred; // dLL/dz
      gTheta.set(a.playerId, gTheta.get(a.playerId)! + err);
      gBeta.set(a.questionId, gBeta.get(a.questionId)! - err);
      gGamma.set(a.format, gGamma.get(a.format)! + err);
    }

    // Ridge pull toward 0.
    for (const p of players) gTheta.set(p, gTheta.get(p)! - opts.ridge * theta.get(p)!);
    for (const q of questions) gBeta.set(q, gBeta.get(q)! - opts.ridge * beta.get(q)!);
    for (const f of formats) gGamma.set(f, gGamma.get(f)! - opts.gammaRidge * gamma.get(f)!);

    const lr = opts.learningRate / answers.length;
    for (const p of players) theta.set(p, theta.get(p)! + lr * gTheta.get(p)!);
    for (const q of questions) beta.set(q, beta.get(q)! + lr * gBeta.get(q)!);
    for (const f of formats) gamma.set(f, gamma.get(f)! + lr * gGamma.get(f)!);

    // Identifiability: anchor mean(theta)=0 (absorb into beta) and pin the
    // reference format's gamma to 0 (absorb into beta).
    const meanTheta = mean([...theta.values()]);
    for (const p of players) theta.set(p, theta.get(p)! - meanTheta);
    for (const q of questions) beta.set(q, beta.get(q)! - meanTheta);

    const refGamma = gamma.get(referenceFormat)!;
    if (refGamma !== 0) {
      for (const f of formats) gamma.set(f, gamma.get(f)! - refGamma);
      for (const q of questions) beta.set(q, beta.get(q)! + refGamma);
    }

    const ll = logLikelihood(answers, theta, beta, gamma);
    if (Math.abs(ll - prevLL) < opts.tolerance * Math.max(1, Math.abs(prevLL))) {
      converged = true;
      iter += 1;
      prevLL = ll;
      break;
    }
    prevLL = ll;
  }

  return { theta, beta, gamma, referenceFormat, iters: iter, converged, finalLogLik: prevLL };
}

export function predictProb(
  fit: Pick<LatentFitResult, 'theta' | 'beta' | 'gamma'>,
  answer: Pick<LatentAnswer, 'playerId' | 'questionId' | 'format'>,
): number {
  const t = fit.theta.get(answer.playerId) ?? 0;
  const b = fit.beta.get(answer.questionId) ?? 0;
  const g = fit.gamma.get(answer.format) ?? 0;
  return sigmoid(t - b + g);
}

function logLikelihood(
  answers: readonly LatentAnswer[],
  theta: Map<string, number>,
  beta: Map<string, number>,
  gamma: Map<string, number>,
): number {
  let ll = 0;
  for (const a of answers) {
    const z = theta.get(a.playerId)! - beta.get(a.questionId)! + gamma.get(a.format)!;
    const p = sigmoid(z);
    const clamped = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
    ll += a.correct === 1 ? Math.log(clamped) : Math.log(1 - clamped);
  }
  return ll;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}
