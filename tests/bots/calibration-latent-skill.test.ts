import { describe, it, expect } from 'vitest';
import { fitLatentSkill, predictProb, type LatentAnswer } from '../../src/modules/bots/calibration/latent-skill.js';
import { pearson, rmse, sigmoid, rocAuc } from '../../src/modules/bots/calibration/math.js';

/** Deterministic mulberry32 (same algorithm as src/core/rng.ts). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Synthetic {
  answers: LatentAnswer[];
  trueTheta: Map<string, number>;
  players: string[];
}

/**
 * Correct generative model (finding #3): each question has exactly ONE fixed
 * difficulty (no per-observation format randomization). P(correct) =
 * sigmoid(theta_p - beta_q). `answersPerPlayer` controls the per-player sample
 * so we can exercise the sparse-at-scale regime.
 */
function makeSynthetic(nPlayers: number, nQuestions: number, answersPerPlayer: number, seed: number): Synthetic {
  const rng = mulberry32(seed);
  const gauss = (): number => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const players: string[] = [];
  const trueTheta = new Map<string, number>();
  for (let i = 0; i < nPlayers; i += 1) {
    const id = `p${i}`;
    players.push(id);
    trueTheta.set(id, gauss());
  }
  const trueBeta = new Map<string, number>();
  for (let j = 0; j < nQuestions; j += 1) trueBeta.set(`q${j}`, gauss() * 1.2);

  const answers: LatentAnswer[] = [];
  for (const p of players) {
    for (let k = 0; k < answersPerPlayer; k += 1) {
      const qId = `q${Math.floor(rng() * nQuestions)}`;
      const z = trueTheta.get(p)! - trueBeta.get(qId)!;
      answers.push({ playerId: p, questionId: qId, correct: rng() < sigmoid(z) ? 1 : 0 });
    }
  }
  return { answers, trueTheta, players };
}

function std(xs: number[]): number {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length);
}

describe('fitLatentSkill synthetic recovery (Rasch, no format term)', () => {
  it('recovers known player skills from simulated Bernoulli answers', () => {
    const { answers, trueTheta, players } = makeSynthetic(120, 60, 120, 12345);
    const fit = fitLatentSkill(answers);

    const recovered = players.map((p) => fit.theta.get(p)!);
    const truthRaw = players.map((p) => trueTheta.get(p)!);
    const truthMean = truthRaw.reduce((s, x) => s + x, 0) / truthRaw.length;
    const truth = truthRaw.map((x) => x - truthMean);

    expect(pearson(truth, recovered)).toBeGreaterThan(0.9);
    expect(rmse(truth, recovered)).toBeLessThan(0.4);
    expect(fit.converged).toBe(true);
  });

  it('produces well-calibrated holdout predictions (AUC well above chance)', () => {
    const { answers } = makeSynthetic(120, 60, 120, 42);
    const split = mulberry32(7);
    const train: LatentAnswer[] = [];
    const test: LatentAnswer[] = [];
    for (const a of answers) (split() < 0.2 ? test : train).push(a);
    const fit = fitLatentSkill(train);
    const scored = test.filter((a) => fit.theta.has(a.playerId) && fit.beta.has(a.questionId));
    const preds = scored.map((a) => predictProb(fit, a));
    const labels = scored.map((a) => a.correct);
    expect(rocAuc(preds, labels)).toBeGreaterThan(0.7);
  });

  /**
   * Finding #4: at production scale (large TOTAL row count, but each player has
   * only ~150 answers), a global 1/N learning rate froze theta near zero. The
   * coordinate-normalized optimizer must recover a theta spread comparable to
   * the true spread and NOT compress. 1500 players × 150 answers = 225k rows.
   */
  it('does NOT compress theta at realistic scale (225k obs, 150-answer players)', () => {
    const { answers, trueTheta, players } = makeSynthetic(1500, 300, 150, 2024);
    const fit = fitLatentSkill(answers, { maxIters: 500 });

    const recovered = players.map((p) => fit.theta.get(p)!);
    const truthRaw = players.map((p) => trueTheta.get(p)!);
    const truthMean = truthRaw.reduce((s, x) => s + x, 0) / truthRaw.length;
    const truth = truthRaw.map((x) => x - truthMean);

    // The recovered spread must be a substantial fraction of the true spread —
    // NOT compressed toward 0 (the old 1/N optimizer gave ~0.2 vs true ~1.0).
    expect(std(recovered)).toBeGreaterThan(0.6 * std(truth));
    expect(pearson(truth, recovered)).toBeGreaterThan(0.9);
  }, 60000);

  it('reports non-convergence honestly when starved of iterations', () => {
    const { answers } = makeSynthetic(60, 40, 60, 5);
    const fit = fitLatentSkill(answers, { maxIters: 1, tolerance: 1e-9 });
    expect(fit.converged).toBe(false);
    expect(fit.finalUpdateNorm).toBeGreaterThan(0);
  });
});
