import { describe, it, expect } from 'vitest';
import { fitLatentSkill, filterDegenerateParams, predictProb, type LatentAnswer } from '../../src/modules/bots/calibration/latent-skill.js';
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

    // Compare only players present in the fit (a degenerate player, if any, is
    // dropped). Recenter the true skills of that same subset to mean 0.
    const present = players.filter((p) => fit.theta.has(p));
    const recovered = present.map((p) => fit.theta.get(p)!);
    const truthRaw = present.map((p) => trueTheta.get(p)!);
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

    const present = players.filter((p) => fit.theta.has(p));
    const recovered = present.map((p) => fit.theta.get(p)!);
    const truthRaw = present.map((p) => trueTheta.get(p)!);
    const truthMean = truthRaw.reduce((s, x) => s + x, 0) / truthRaw.length;
    const truth = truthRaw.map((x) => x - truthMean);

    // The recovered spread must be a substantial fraction of the true spread —
    // NOT compressed toward 0 (the old 1/N optimizer gave ~0.2 vs true ~1.0).
    expect(std(recovered)).toBeGreaterThan(0.6 * std(truth));
    expect(pearson(truth, recovered)).toBeGreaterThan(0.9);
  }, 60000);

  it('reports non-convergence honestly (with diagnostics) when starved', () => {
    const { answers } = makeSynthetic(60, 40, 60, 5);
    const fit = fitLatentSkill(answers, { maxIters: 1, tolerance: 1e-9 });
    expect(fit.converged).toBe(false);
    expect(fit.finalUpdateNorm).toBeGreaterThan(0);
    // The diagnostics dump names the largest remaining updates.
    expect(fit.diagnostics).toBeDefined();
    expect(fit.diagnostics!.length).toBeGreaterThan(0);
    const top = fit.diagnostics![0];
    expect(top.kind === 'player' || top.kind === 'question').toBe(true);
    expect(top.answers).toBeGreaterThan(0);
    expect(top.observedAccuracy).toBeGreaterThanOrEqual(0);
  });

  it('anchoring keeps mean(theta) at machine zero (identifiability preserved)', () => {
    const { answers } = makeSynthetic(80, 50, 80, 99);
    const fit = fitLatentSkill(answers);
    const meanTheta = [...fit.theta.values()].reduce((s, x) => s + x, 0) / fit.theta.size;
    expect(Math.abs(meanTheta)).toBeLessThan(1e-9);
  });
});

describe('perfect separation (the prod non-convergence pathology)', () => {
  /**
   * Builds a normal cohort PLUS perfectly-separated params: `nEasy` questions
   * everyone answered 100% correctly and one player who answered 100% correctly.
   * These carry no discriminative info and, under a weak ridge, drift to a large
   * ridge-set magnitude that (with the OLD post-step anchor) pinned updateNorm
   * just above tolerance forever.
   */
  function withSeparation(nEasy: number, seed: number): { answers: LatentAnswer[]; easyIds: string[]; godId: string } {
    const { answers, players } = makeSynthetic(80, 60, 80, seed);
    const rng = mulberry32(seed ^ 0x1234);
    const easyIds: string[] = [];
    for (let e = 0; e < nEasy; e += 1) {
      const qId = `qEasy${e}`;
      easyIds.push(qId);
      for (let k = 0; k < 4; k += 1) answers.push({ playerId: players[Math.floor(rng() * players.length)], questionId: qId, correct: 1 });
    }
    const godId = 'pGod';
    for (let k = 0; k < 50; k += 1) answers.push({ playerId: godId, questionId: `q${Math.floor(rng() * 60)}`, correct: 1 });
    return { answers, easyIds, godId };
  }

  it('filterDegenerateParams removes 0%/100% questions and players (to a fixed point)', () => {
    const { answers, easyIds, godId } = withSeparation(40, 2024);
    const f = filterDegenerateParams(answers);
    for (const q of easyIds) expect(f.excludedQuestions).toContain(q);
    expect(f.excludedPlayers).toContain(godId);
    // The kept set contains no all-0/all-1 question or player.
    const qAgg = new Map<string, { c: number; n: number }>();
    const pAgg = new Map<string, { c: number; n: number }>();
    for (const a of f.kept) {
      const q = qAgg.get(a.questionId) ?? { c: 0, n: 0 }; q.c += a.correct; q.n += 1; qAgg.set(a.questionId, q);
      const p = pAgg.get(a.playerId) ?? { c: 0, n: 0 }; p.c += a.correct; p.n += 1; pAgg.set(a.playerId, p);
    }
    for (const [, g] of qAgg) expect(g.c !== 0 && g.c !== g.n).toBe(true);
    for (const [, g] of pAgg) expect(g.c !== 0 && g.c !== g.n).toBe(true);
  });

  it('CONVERGES on perfectly-separated data and excludes the degenerate params', () => {
    const { answers, easyIds, godId } = withSeparation(40, 2024);
    const fit = fitLatentSkill(answers, { maxIters: 40000 });
    // The whole point: this used to plateau at ~1.05e-4 forever; now it converges.
    expect(fit.converged).toBe(true);
    expect(fit.iters).toBeLessThan(5000);
    expect(fit.finalUpdateNorm).toBeLessThan(1e-4);
    // Degenerate params were dropped and are NOT in the fitted maps.
    expect(fit.excluded.questions.length).toBe(easyIds.length);
    expect(fit.excluded.players).toContain(godId);
    for (const q of easyIds) expect(fit.beta.has(q)).toBe(false);
    expect(fit.theta.has(godId)).toBe(false);
  });

  it('CONVERGES on separated data even with the degenerate filter OFF (anchor-fix alone)', () => {
    // Proves the plateau was the anchor/ridge interaction, not just separation:
    // with filtering disabled, the projected-gradient anchor still converges
    // (the OLD post-step anchor would run to maxIters without converging).
    const { answers } = withSeparation(40, 2024);
    const fit = fitLatentSkill(answers, { filterDegenerate: false, maxIters: 40000 });
    expect(fit.converged).toBe(true);
    expect(fit.iters).toBeLessThan(5000);
  });
});
