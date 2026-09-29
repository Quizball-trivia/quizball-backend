import { BM_TIERS } from '../../src/modules/duel/engines/buscaminas.engine.js';
import type { DuelCtx } from '../../src/modules/duel/duel.types.js';

const text = (s: string) => ({ es: `${s} es`, en: `${s} en`, ka: `${s} ka`, tr: `${s} tr` });

/** Round r: cards c0..c15; c0..c11 fit, c12..c15 are the impostors. */
export function buscaminasPack() {
  return {
    rounds: BM_TIERS.map((difficulty, r) => ({
      id: `bm-${r}`,
      difficulty,
      prompt: text(`Categoría ${r}`),
      cards: Array.from({ length: 16 }, (_, i) => ({ id: `c${i}`, name: `Jugador ${r}.${i}`, img: `/p/${r}-${i}.webp` })),
      ok: Array.from({ length: 12 }, (_, i) => `c${i}`),
    })),
  };
}

/** Round r's answer is "Número r" (accepted also "Numerito r"). */
export function pistasPack() {
  return {
    rounds: Array.from({ length: 10 }, (_, r) => ({
      id: `pf-${r}`,
      difficulty: r % 3 === 0 ? 'easy' : r % 3 === 1 ? 'medium' : 'hard',
      clues: Array.from({ length: 10 }, (_, c) => ({ kind: c < 3 ? 'position' : 'fact', icon: c < 3 ? 'FW' : null, text: text(`pista ${r}.${c + 1}`) })),
      answer: { display: text(`Número ${r}`), accepted: [`Número ${r}`, `Numerito ${r}`] },
    })),
  };
}

export const ctx = (rolls: number[] = [0.1], remainingMs = 45_000): DuelCtx => {
  let i = 0;
  return { rng: () => rolls[i++ % rolls.length], remainingMs };
};
