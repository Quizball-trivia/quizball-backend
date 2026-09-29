import type { UltimoCategory } from '../../src/modules/ultimo/ultimo.match.js';
import { addDays, CONTENT_START, dayNumber } from '../../src/modules/ultimo/ultimo.days.js';

/** Fictional content only (the repository is public): no real list may appear in a test. */
const same = (name: string) => ({ es: name, en: name, ka: name, tr: name });
const answer = (id: string, name: string, aliases: string[] = [], display?: Partial<Record<'es' | 'en' | 'ka' | 'tr', string>>) =>
  ({ id, display: { ...same(name), ...display }, aliases });

export function category(id = 'cat-a', extra: Partial<UltimoCategory> = {}): UltimoCategory {
  return {
    id,
    difficulty: 'easy',
    title: same(`Plantel ficticio ${id}`),
    hint: same('Una lista inventada'),
    answers: [
      answer('ana', 'Ana Martel'),
      answer('bruno', 'Bruno Martel'),
      answer('carla', 'Carla Martel'),
      answer('diego', 'Diego De Lucca'),
      answer('emilio', 'Emilio Varga', ['Emi']),
      answer('fabian', 'Fabián Sosa', ['Rojo']),
      answer('gaston', 'Gastón Rojo'),
      answer('isik', 'Işık Yılmaz'),
      answer('arcadia', 'Nueva Arcadia', [], { ka: 'ახალი არკადია', tr: 'Yeni Arkadya' }),
      answer('rossi', 'Lía Rossi'),
      answer('rosso', 'Mora Rosso'),
      answer('petrov', 'Iván Petrov'),
    ],
    ...extra,
  };
}

/** A category of `n` answers with plain unique names (for completion paths). */
export function plainCategory(id: string, n: number, difficulty: UltimoCategory['difficulty'] = 'easy'): UltimoCategory {
  return {
    id, difficulty, title: same(`Lista ${id}`), hint: same('Inventada'),
    answers: Array.from({ length: n }, (_, i) => answer(`${id}-${i}`, `Jugador${String.fromCharCode(97 + i)} Apellido${String.fromCharCode(97 + i)}${id}`)),
  };
}

export const nameOf = (c: UltimoCategory, i: number) => c.answers[i].display.es;

export function makeDay(offset: number, categories?: UltimoCategory[]) {
  const day = addDays(CONTENT_START, offset);
  return { day, number: dayNumber(day), categories: categories ?? Array.from({ length: 5 }, (_, i) => plainCategory(`d${offset}c${i}`, 8 + i)) };
}
