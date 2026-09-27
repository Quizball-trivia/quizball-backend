import { randomBytes } from 'node:crypto';
import { indexContent } from '../../src/modules/buscaminas/buscaminas.content.js';
import { addDays, dayNumber, LAUNCH_DAY, PUBLISHED_DAYS } from '../../src/modules/buscaminas/buscaminas.days.js';
import type { BuscaminasDayContent } from '../../src/modules/buscaminas/buscaminas.types.js';

/** Synthetic content only (never the real answers). Round i: cards c0..c15 of which c0..c11 are correct and c12..c15 are mines. */
export function makeDay(day: string, contentVersion = 1): BuscaminasDayContent {
  return {
    day,
    number: dayNumber(day),
    contentVersion,
    rounds: Array.from({ length: 20 }, (_, r) => ({
      id: `r${r}`,
      cards: Array.from({ length: 16 }, (_, c) => ({ id: `r${r}c${c}`, ok: c < 12 })),
    })),
  };
}

export const okCards = (r: number): string[] => Array.from({ length: 12 }, (_, c) => `r${r}c${c}`);
export const mineCards = (r: number): string[] => Array.from({ length: 4 }, (_, c) => `r${r}c${c + 12}`);

export const indexOf = (...days: BuscaminasDayContent[]) => indexContent(days);

export const testKey = (): string => randomBytes(32).toString('hex');

/** The full published calendar the loader requires: PUBLISHED_DAYS contiguous days from LAUNCH_DAY, numbered by position. */
export const calendar = (contentVersion = 1): BuscaminasDayContent[] =>
  Array.from({ length: PUBLISHED_DAYS }, (_, i) => makeDay(addDays(LAUNCH_DAY, i), contentVersion + i));
