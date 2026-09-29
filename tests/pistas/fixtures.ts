import { indexDay, type ContentIndex, type IndexedDay } from '../../src/modules/pistas/pistas.content.js';
import { addDays, CONTENT_START, dayNumber, PUBLISHED_DAYS } from '../../src/modules/pistas/pistas.days.js';
import { parseDayFile, toDayRow, type SeedDay } from '../../src/modules/pistas/pistas.seed.js';
import type { ClueKind } from '../../src/modules/pistas/pistas.types.js';

const KINDS: ClueKind[] = ['confed', 'position', 'foot', 'decade', 'fact', 'fact', 'fact', 'fact', 'fact', 'fact'];
const ICONS: Array<string | null> = ['confed:uefa', 'position:mid', 'foot:left', null, null, null, null, null, null, null];

/**
 * A day file as the content pipeline writes it — synthetic content only, never real answers. Round r's
 * answer is "Número r" (es) / "Numero r" (en) / "ნომერი r" (ka) / "Numara r" (tr), also accepted as
 * "N r". `variant` changes one clue text, so the content (and its version) changes.
 */
export function rawDay(day: string, variant = 0) {
  return {
    day,
    number: dayNumber(day),
    rounds: Array.from({ length: 10 }, (_, r) => ({
      id: `r${r}`,
      difficulty: r < 4 ? 'easy' : r < 8 ? 'medium' : 'hard',
      answer: {
        display: { es: `Número ${r}`, en: `Numero ${r}`, ka: `ნომერი ${r}`, tr: `Numara ${r}` },
        accepted: [`Numero ${r}`, `ნომერი ${r}`, `Numara ${r}`, `N ${r}`],
      },
      clues: Array.from({ length: 10 }, (_, c) => ({
        kind: KINDS[c],
        icon: ICONS[c],
        text: {
          es: `pista ${r}.${c}${c === 9 && variant ? ` v${variant}` : ''}`,
          en: `clue ${r}.${c}`,
          ka: `მინიშნება ${r}.${c}`,
          tr: `ipucu ${r}.${c}`,
        },
      })),
      source: { questionIds: [`q-${r}`], playerId: `p-${r}` },
    })),
  };
}

export const makeDay = (day: string, variant = 0): SeedDay => parseDayFile(`${day}.json`, rawDay(day, variant));

export const indexed = (d: SeedDay): IndexedDay => indexDay(toDayRow(d))!;

export const indexOf = (...days: SeedDay[]): ContentIndex => new Map(days.map((d) => [d.day, indexed(d)]));

/** The published calendar the seed requires: PUBLISHED_DAYS contiguous days from CONTENT_START. */
export const calendar = (): SeedDay[] => Array.from({ length: PUBLISHED_DAYS }, (_, i) => makeDay(addDays(CONTENT_START, i)));

export const answerOf = (r: number): string => `Numero ${r}`;
