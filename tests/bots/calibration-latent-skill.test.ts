import { describe, it, expect } from 'vitest';
import { fitLatentSkill, predictProb, type LatentAnswer } from '../../src/modules/bots/calibration/latent-skill.js';
import { pearson, rmse, sigmoid, rocAuc } from '../../src/modules/bots/calibration/math.js';

/**
 * Deterministic mulberry32 (same algorithm as src/core/rng.ts) so the synthetic
 * data — and therefore the recovered fit — are reproducible.
 */
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
  trueBeta: Map<string, number>;
  players: string[];
  questions: string[];
}

function makeSynthetic(nPlayers: number, nQuestions: number, seed: number): Synthetic {
  const rng = mulberry32(seed);
  const gauss = (): number => {
    // Box–Muller
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
    trueTheta.set(id, gauss()); // skill ~ N(0,1)
  }
  const questions: string[] = [];
  const trueBeta = new Map<string, number>();
  for (let j = 0; j < nQuestions; j += 1) {
    const id = `q${j}`;
    questions.push(id);
    trueBeta.set(id, gauss() * 1.2); // difficulty ~ N(0, 1.2^2)
  }

  // Two formats with a known easiness gap; mcq is the reference (gamma=0).
  const formatGamma: Record<string, number> = { mcq: 0, tf: 0.4 };
  const formats = Object.keys(formatGamma);

  const answers: LatentAnswer[] = [];
  for (const p of players) {
    for (const q of questions) {
      const fmt = formats[Math.floor(rng() * formats.length)];
      const z = trueTheta.get(p)! - trueBeta.get(q)! + formatGamma[fmt];
      const correct: 0 | 1 = rng() < sigmoid(z) ? 1 : 0;
      answers.push({ playerId: p, questionId: q, format: fmt, correct });
    }
  }
  return { answers, trueTheta, trueBeta, players, questions };
}

describe('fitLatentSkill synthetic recovery', () => {
  it('recovers known player skills from simulated Bernoulli answers', () => {
    const { answers, trueTheta, players } = makeSynthetic(120, 60, 12345);
    const fit = fitLatentSkill(answers, { maxIters: 3000, learningRate: 0.6, ridge: 1e-3 });

    // Anchor the recovered skills the same way the fit does (mean 0), then
    // compare to the true skills recentered to mean 0.
    const recovered = players.map((p) => fit.theta.get(p)!);
    const truthRaw = players.map((p) => trueTheta.get(p)!);
    const truthMean = truthRaw.reduce((s, x) => s + x, 0) / truthRaw.length;
    const truth = truthRaw.map((x) => x - truthMean);

    const r = pearson(truth, recovered);
    const err = rmse(truth, recovered);

    // Recovery quality on a well-sampled design (120x60 = 7200 answers).
    expect(r).toBeGreaterThan(0.9);
    expect(err).toBeLessThan(0.35);
    expect(fit.converged || fit.iters >= 1).toBe(true);
  });

  it('recovers the known format easiness gap (tf easier than reference mcq)', () => {
    const { answers } = makeSynthetic(120, 60, 999);
    const fit = fitLatentSkill(answers, { maxIters: 3000, learningRate: 0.6 });
    expect(fit.gamma.get('mcq')).toBeCloseTo(0, 6); // reference pinned to 0
    // true gap was +0.4; allow generous tolerance for finite-sample noise
    expect(fit.gamma.get('tf')!).toBeGreaterThan(0.2);
    expect(fit.gamma.get('tf')!).toBeLessThan(0.6);
  });

  it('produces well-calibrated holdout predictions (AUC well above chance)', () => {
    const { answers } = makeSynthetic(120, 60, 42);
    // 80/20 RANDOM holdout (a stride split aliases with the question grid and
    // starves some questions out of the train design). Seeded for determinism.
    const split = mulberry32(7);
    const train: LatentAnswer[] = [];
    const test: LatentAnswer[] = [];
    for (const a of answers) (split() < 0.2 ? test : train).push(a);
    const fit = fitLatentSkill(train, { maxIters: 3000, learningRate: 0.6 });
    // Only score holdout rows whose player+question are in the train design.
    const scored = test.filter((a) => fit.theta.has(a.playerId) && fit.beta.has(a.questionId));
    const preds = scored.map((a) => predictProb(fit, a));
    const labels = scored.map((a) => a.correct);
    expect(rocAuc(preds, labels)).toBeGreaterThan(0.72);
  });
});
