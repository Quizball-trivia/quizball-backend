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
 * froze sparse players near zero at production scale.
 *
 * Identifiability & convergence (see the perfect-separation post-mortem):
 *   Only differences theta_p - beta_q are identified, so a constant added to all
 *   theta (and removed from all beta) is a free direction. We pin it by
 *   PROJECTING the theta step to be mean-zero every iteration (subtract the mean
 *   theta step from each theta step). Because theta starts mean-zero and every
 *   step is mean-zero, mean(theta) stays 0 by construction.
 *
 *   The previous approach anchored by subtracting mean(theta) from every theta
 *   AND beta AFTER the step. With degenerate (perfectly-separated) parameters,
 *   the ridge pulls their large-magnitude values asymmetrically, leaving a
 *   persistent tiny mean(theta) every iteration; the post-step subtraction then
 *   re-shifted every parameter by that constant — a PREDICTION-INVARIANT move
 *   that was nonetheless counted in the convergence metric, pinning updateNorm
 *   just above tolerance forever (observed on prod: constant 1.05e-4 at 5k AND
 *   40k iters). Projecting the step instead never introduces that spurious move.
 *
 * Degenerate pre-filter: questions answered 0% or 100% correctly among the fit
 * answers (and players at 0%/100%) carry no discriminative information — their
 * beta/theta is only bounded by the ridge and drifts to a large ridge-set
 * magnitude. They are dropped from the fit (reported in `excluded`); their
 * question_stats entry is unaffected (smoothing already yields a difficulty).
 *
 * Convergence is a hard gate: `converged` is true only if the mean absolute
 * per-parameter (projected) update fell below `tolerance`. Callers that emit
 * production params MUST refuse to write when this is false — and can surface
 * `diagnostics` (the largest remaining updates with their observed accuracy) to
 * name the next pathology.
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
  /**
   * Drop questions/players whose observed accuracy is exactly 0% or 100% among
   * the fit answers (no discriminative information; only bounded by the ridge).
   * Default true. Set false only to study the raw fit.
   */
  filterDegenerate?: boolean;
}

/** One remaining large update at non-convergence, for the diagnostics dump. */
export interface FitDiagnosticEntry {
  kind: 'player' | 'question';
  id: string;
  update: number;
  value: number;
  observedAccuracy: number;
  answers: number;
}

export interface LatentFitResult {
  theta: Map<string, number>;
  beta: Map<string, number>;
  iters: number;
  converged: boolean;
  finalLogLik: number;
  /** Mean-abs per-parameter (projected) update on the final iteration. */
  finalUpdateNorm: number;
  /** Params dropped as degenerate before fitting (0%/100% observed accuracy). */
  excluded: { players: string[]; questions: string[] };
  /**
   * Present only when the fit did NOT converge: the largest remaining updates
   * with their observed accuracy/answer counts, so the next pathology is legible.
   */
  diagnostics?: FitDiagnosticEntry[];
}

const DEFAULTS: Required<LatentFitOptions> = {
  learningRate: 1.0,
  maxIters: 5000,
  tolerance: 1e-4,
  ridge: 1e-2,
  filterDegenerate: true,
};

interface Aggregate {
  correct: number;
  total: number;
}

/**
 * Remove questions and players whose observed accuracy is exactly 0 or 1 among
 * the answers. Iterated to a fixed point: dropping a degenerate question can
 * make a player degenerate on the remainder, and vice versa. Returns the kept
 * answers plus the ids removed.
 */
export function filterDegenerateParams(answers: readonly LatentAnswer[]): {
  kept: LatentAnswer[];
  excludedPlayers: string[];
  excludedQuestions: string[];
} {
  let current: LatentAnswer[] = [...answers];
  const excludedPlayers = new Set<string>();
  const excludedQuestions = new Set<string>();

  for (;;) {
    const pAgg = new Map<string, Aggregate>();
    const qAgg = new Map<string, Aggregate>();
    for (const a of current) {
      const p = pAgg.get(a.playerId) ?? { correct: 0, total: 0 };
      p.correct += a.correct;
      p.total += 1;
      pAgg.set(a.playerId, p);
      const q = qAgg.get(a.questionId) ?? { correct: 0, total: 0 };
      q.correct += a.correct;
      q.total += 1;
      qAgg.set(a.questionId, q);
    }

    const badPlayers = new Set<string>();
    for (const [id, g] of pAgg) if (g.total > 0 && (g.correct === 0 || g.correct === g.total)) badPlayers.add(id);
    const badQuestions = new Set<string>();
    for (const [id, g] of qAgg) if (g.total > 0 && (g.correct === 0 || g.correct === g.total)) badQuestions.add(id);

    if (badPlayers.size === 0 && badQuestions.size === 0) break;

    for (const p of badPlayers) excludedPlayers.add(p);
    for (const q of badQuestions) excludedQuestions.add(q);
    current = current.filter((a) => !badPlayers.has(a.playerId) && !badQuestions.has(a.questionId));
    if (current.length === 0) break;
  }

  return { kept: current, excludedPlayers: [...excludedPlayers], excludedQuestions: [...excludedQuestions] };
}

export function fitLatentSkill(answers: readonly LatentAnswer[], options: LatentFitOptions = {}): LatentFitResult {
  const opts = { ...DEFAULTS, ...options };
  if (answers.length === 0) throw new Error('fitLatentSkill: no answers');

  const excluded = { players: [] as string[], questions: [] as string[] };
  let fitAnswers: readonly LatentAnswer[] = answers;
  if (opts.filterDegenerate) {
    const f = filterDegenerateParams(answers);
    fitAnswers = f.kept;
    excluded.players = f.excludedPlayers;
    excluded.questions = f.excludedQuestions;
    if (fitAnswers.length === 0) {
      throw new Error('fitLatentSkill: all answers were degenerate (every player/question is 0% or 100%)');
    }
  }

  const players = [...new Set(fitAnswers.map((a) => a.playerId))];
  const questions = [...new Set(fitAnswers.map((a) => a.questionId))];

  const theta = new Map<string, number>(players.map((p) => [p, 0]));
  const beta = new Map<string, number>(questions.map((q) => [q, 0]));

  // Per-parameter observation counts for coordinate normalization + diagnostics.
  const nTheta = new Map<string, number>(players.map((p) => [p, 0]));
  const nBeta = new Map<string, number>(questions.map((q) => [q, 0]));
  const cTheta = new Map<string, number>(players.map((p) => [p, 0]));
  const cBeta = new Map<string, number>(questions.map((q) => [q, 0]));
  for (const a of fitAnswers) {
    nTheta.set(a.playerId, nTheta.get(a.playerId)! + 1);
    nBeta.set(a.questionId, nBeta.get(a.questionId)! + 1);
    cTheta.set(a.playerId, cTheta.get(a.playerId)! + a.correct);
    cBeta.set(a.questionId, cBeta.get(a.questionId)! + a.correct);
  }

  let iter = 0;
  let converged = false;
  let updateNorm = Infinity;
  let lastThetaStep = new Map<string, number>();
  let lastBetaStep = new Map<string, number>();

  for (; iter < opts.maxIters; iter += 1) {
    const gTheta = new Map<string, number>(players.map((p) => [p, 0]));
    const gBeta = new Map<string, number>(questions.map((q) => [q, 0]));

    for (const a of fitAnswers) {
      const pred = sigmoid(theta.get(a.playerId)! - beta.get(a.questionId)!);
      const err = a.correct - pred; // dLL/dz
      gTheta.set(a.playerId, gTheta.get(a.playerId)! + err);
      gBeta.set(a.questionId, gBeta.get(a.questionId)! - err);
    }

    // Compute the raw theta steps, then PROJECT them to mean-zero so mean(theta)
    // is preserved at its initial 0 by construction — no separate post-step
    // anchor, so no prediction-invariant re-shift is ever counted as progress.
    const thetaSteps = new Map<string, number>();
    let meanThetaStep = 0;
    for (const p of players) {
      const n = nTheta.get(p)!;
      const step = opts.learningRate * (gTheta.get(p)! - opts.ridge * theta.get(p)!) / (n + opts.ridge);
      thetaSteps.set(p, step);
      meanThetaStep += step;
    }
    meanThetaStep /= players.length;

    let sumAbs = 0;
    let count = 0;
    const curThetaStep = new Map<string, number>();
    const curBetaStep = new Map<string, number>();

    for (const p of players) {
      const step = thetaSteps.get(p)! - meanThetaStep;
      theta.set(p, theta.get(p)! + step);
      curThetaStep.set(p, step);
      sumAbs += Math.abs(step);
      count += 1;
    }
    for (const q of questions) {
      const n = nBeta.get(q)!;
      const step = opts.learningRate * (gBeta.get(q)! - opts.ridge * beta.get(q)!) / (n + opts.ridge);
      beta.set(q, beta.get(q)! + step);
      curBetaStep.set(q, step);
      sumAbs += Math.abs(step);
      count += 1;
    }

    lastThetaStep = curThetaStep;
    lastBetaStep = curBetaStep;
    updateNorm = count > 0 ? sumAbs / count : 0;
    if (updateNorm < opts.tolerance) {
      converged = true;
      iter += 1;
      break;
    }
  }

  const result: LatentFitResult = {
    theta,
    beta,
    iters: iter,
    converged,
    finalLogLik: logLikelihood(fitAnswers, theta, beta),
    finalUpdateNorm: updateNorm,
    excluded,
  };

  if (!converged) {
    result.diagnostics = buildDiagnostics(lastThetaStep, lastBetaStep, theta, beta, cTheta, nTheta, cBeta, nBeta);
  }

  return result;
}

/** Top-10 largest remaining per-parameter updates with observed accuracy/counts. */
function buildDiagnostics(
  thetaStep: Map<string, number>,
  betaStep: Map<string, number>,
  theta: Map<string, number>,
  beta: Map<string, number>,
  cTheta: Map<string, number>,
  nTheta: Map<string, number>,
  cBeta: Map<string, number>,
  nBeta: Map<string, number>,
): FitDiagnosticEntry[] {
  const entries: FitDiagnosticEntry[] = [];
  for (const [id, step] of thetaStep) {
    entries.push({
      kind: 'player',
      id,
      update: Math.abs(step),
      value: theta.get(id)!,
      observedAccuracy: nTheta.get(id)! > 0 ? cTheta.get(id)! / nTheta.get(id)! : 0,
      answers: nTheta.get(id)!,
    });
  }
  for (const [id, step] of betaStep) {
    entries.push({
      kind: 'question',
      id,
      update: Math.abs(step),
      value: beta.get(id)!,
      observedAccuracy: nBeta.get(id)! > 0 ? cBeta.get(id)! / nBeta.get(id)! : 0,
      answers: nBeta.get(id)!,
    });
  }
  return entries.sort((a, b) => b.update - a.update).slice(0, 10);
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
