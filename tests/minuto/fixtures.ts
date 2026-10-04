import { createHash } from 'node:crypto';
import { indexDay, type ContentIndex, type IndexedDay } from '../../src/modules/minuto/minuto.content.js';
import { addDays, CONTENT_START, dayNumber } from '../../src/modules/minuto/minuto.days.js';
import { parseDayFile, toDayRow, type SeedDay } from '../../src/modules/minuto/minuto.seed.js';

/**
 * Synthetic goals only, never real matches: "Equipo A{r}" v "Equipo B{r}", scorer "Goleador {r}". Goal r of a day
 * is scored at minute 10 + 7r; goal 9 is in added time (90+4) so the added-time paths are covered.
 */
const name = (s: string) => ({ es: s, en: s, ka: s, tr: s });
const print = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export const minuteOf = (r: number): { base: number; added: number } => (r === 9 ? { base: 90, added: 4 } : { base: 10 + 7 * r, added: 0 });

export const goalIdOf = (day: string, r: number) => `g${day.replace(/-/g, '')}-${print(`id|${day}|${r}`).slice(0, 10)}`;

export function rawGoal(day: string, r: number, variant = 0) {
  const id = goalIdOf(day, r);
  return {
    id,
    fingerprint: print(`${id}|${variant}`),
    tier: r < 3 ? 'easy' : r < 7 ? 'medium' : 'hard',
    comp: r % 2 === 0 ? 'FIWC' : 'CL',
    year: 2020 + (r % 5),
    date: '2022-06-1' + (r % 10),
    stage: r === 0 ? 'final' : 'group',
    group: r === 0 ? null : 'A',
    leg: null,
    home: r % 2 === 0 ? { kind: 'nation', flag: 'ar', name: name(`Equipo A${r}`) } : { kind: 'club', crest: null, name: name(`Equipo A${r}`) },
    away: { kind: 'club', crest: 'club-logos/equipo-b.webp', name: name(`Equipo B${r}${variant ? ` v${variant}` : ''}`) },
    score: [2, 1],
    aet: false,
    pens: null,
    side: 'home',
    scorer: { name: name(`Goleador ${r}`), photo: null },
    penalty: false,
    scoreAfter: [1, 0],
    image: null,
    minute: minuteOf(r),
  };
}

export const rawDay = (day: string, variant = 0) => ({
  day, number: dayNumber(day), goals: Array.from({ length: 10 }, (_, r) => rawGoal(day, r, variant)),
});

export const makeDay = (day: string, variant = 0): SeedDay => parseDayFile(`${day}.json`, rawDay(day, variant));
export const indexed = (d: SeedDay): IndexedDay => indexDay(toDayRow(d))!;
export const indexOf = (...days: SeedDay[]): ContentIndex => new Map(days.map((d) => [d.day, indexed(d)]));
export const CALENDAR_DAYS = 75;
export const calendar = (): SeedDay[] => Array.from({ length: CALENDAR_DAYS }, (_, i) => makeDay(addDays(CONTENT_START, i)));
