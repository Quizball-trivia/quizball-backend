import { indexDay, type ContentIndex, type IndexedDay } from '../../src/modules/buscaminas/buscaminas.content.js';
import { addDays, dayNumber, LAUNCH_DAY, PUBLISHED_DAYS } from '../../src/modules/buscaminas/buscaminas.days.js';
import { answerHash, toDayRow, type SeedDay } from '../../src/modules/buscaminas/buscaminas.seed.js';

/**
 * Synthetic content only (never the real answers). Round r: cards r{r}c0..c15 of which c0..c11 fit
 * the clue and c12..c15 are mines. `variant` shifts which cards fit, so the answers (and the hash) change.
 */
export function makeDay(day: string, variant = 0): SeedDay {
  const rounds = Array.from({ length: 20 }, (_, r) => ({
    id: `r${r}`,
    difficulty: r < 10 ? 'easy' as const : 'medium' as const,
    prompt: { es: `pista ${r}`, en: `clue ${r}`, ka: `მინიშნება ${r}`, tr: `ipucu ${r}` },
    cards: Array.from({ length: 16 }, (_, c) => ({ id: `r${r}c${c}`, name: `Player ${r}-${c}`, img: `/buscaminas/v1/p/r${r}c${c}.webp`, ok: (c + variant) % 16 < 12 })),
  }));
  return { day, number: dayNumber(day), contentVersion: answerHash(rounds), rounds };
}

export const okCards = (r: number): string[] => Array.from({ length: 12 }, (_, c) => `r${r}c${c}`);
export const mineCards = (r: number): string[] => Array.from({ length: 4 }, (_, c) => `r${r}c${c + 12}`);

export const indexed = (d: SeedDay): IndexedDay => indexDay(toDayRow(d))!;

export const indexOf = (...days: SeedDay[]): ContentIndex => new Map(days.map((d) => [d.day, indexed(d)]));

/** The full published calendar the seed requires: PUBLISHED_DAYS contiguous days from LAUNCH_DAY. */
export const calendar = (): SeedDay[] => Array.from({ length: PUBLISHED_DAYS }, (_, i) => makeDay(addDays(LAUNCH_DAY, i)));
