import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import * as buscaminas from '../buscaminas/buscaminas.seed.js';
import { LAUNCH_DAY, lastReleasedDay } from '../buscaminas/buscaminas.days.js';
import * as pistas from '../pistas/pistas.seed.js';
import { CONTENT_START as PISTAS_START, lastDay as pistasLastDay } from '../pistas/pistas.days.js';
import * as ultimo from '../ultimo/ultimo.seed.js';
import { CONTENT_START as ULTIMO_START, lastDay as ultimoLastDay } from '../ultimo/ultimo.days.js';
import * as minuto from '../minuto/minuto.seed.js';
import { CONTENT_START as MINUTO_START, lastDay as minutoLastDay } from '../minuto/minuto.days.js';

export const DAILY_GAMES = ['buscaminas', 'pistas', 'ultimo', 'minuto'] as const;
export type DailyGame = (typeof DAILY_GAMES)[number];

export interface BatchPlan {
  entries: Array<{ day: string; number: number; status: string }>;
  /** Stored days the batch leaves as they are (all of them, for an append). */
  keptDays: number;
}

interface GameAdapter {
  table: string;
  /** The advisory lock the game's seeds and pool writes share. */
  contentLock: string;
  /** The stored calendar a batch was validated on (see calendarFingerprint). */
  fingerprint(tx: Sql): Promise<string>;
  contentStart: string;
  /** The calendar's last day, from the days the table stores. */
  lastDay(days: Iterable<string>): string | null;
  /**
   * Validates the batch's day files with the seed CLI's own rules and appends them inside `tx`: never a stored day
   * (appendOnly), never a hole, a repeat or a duel pool overlap. With `dryRun` nothing is written.
   */
  seed(tx: Sql, files: readonly unknown[], dryRun: boolean): Promise<BatchPlan>;
}

const label = (raw: unknown, i: number) => `${(raw as { day?: unknown } | null)?.day ?? `#${i + 1}`}.json`;
const summary = (plan: { entries: ReadonlyArray<{ day: string; number: number; status: string }>; extraDays: readonly string[] }): BatchPlan =>
  ({ entries: plan.entries.map(({ day, number, status }) => ({ day, number, status })), keptDays: plan.extraDays.length });

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The calendar a batch was validated against: sha256 over `day:content_version[:sha256(canonical board)]` lines, in day
 * order. The pipeline records it with the validation; approval recomputes it under the game's lock, so a day corrected
 * after validation (a category, a prompt, a difficulty, an answer) sends the batch back instead of appending it.
 * The pipeline's calendarFingerprint must produce the same string.
 */
export async function calendarFingerprint(tx: Sql, table: string, withBoard = false): Promise<string> {
  const rows = withBoard
    ? await tx<Array<{ day: string; v: string; board: unknown }>>`SELECT day::text AS day, content_version::text AS v, board FROM ${tx(table)} ORDER BY day`
    : await tx<Array<{ day: string; v: string; board?: unknown }>>`SELECT day::text AS day, content_version::text AS v FROM ${tx(table)} ORDER BY day`;
  return sha256(rows.map((r) => (withBoard ? `${r.day}:${r.v}:${sha256(pistas.canonical(r.board))}` : `${r.day}:${r.v}`)).join('\n'));
}

export const GAMES: Record<DailyGame, GameAdapter> = {
  buscaminas: {
    table: 'buscaminas_days',
    contentLock: buscaminas.BUSCAMINAS_CONTENT_LOCK,
    fingerprint: (tx) => calendarFingerprint(tx, 'buscaminas_days', true),
    contentStart: LAUNCH_DAY,
    lastDay: (days) => lastReleasedDay(days, LAUNCH_DAY),
    async seed(tx, files, dryRun) {
      const days = files.map((raw, i) => buscaminas.parseDayFile(label(raw, i), raw));
      buscaminas.assertCalendar(days);
      return summary(await buscaminas.seedDaysTx(tx, days.map(buscaminas.toDayRow), { appendOnly: true, dryRun, allowCorrection: false }));
    },
  },
  pistas: {
    table: 'pistas_days',
    contentLock: pistas.PISTAS_CONTENT_LOCK,
    fingerprint: (tx) => calendarFingerprint(tx, 'pistas_days'),
    contentStart: PISTAS_START,
    lastDay: pistasLastDay,
    async seed(tx, files, dryRun) {
      const days = files.map((raw, i) => pistas.parseDayFile(label(raw, i), raw));
      pistas.assertCalendar(days);
      return summary(await pistas.seedDaysTx(tx, days.map(pistas.toDayRow), { appendOnly: true, dryRun, allowCorrection: false, allowRepeats: false }));
    },
  },
  ultimo: {
    table: 'ultimo_days',
    contentLock: ultimo.ULTIMO_CONTENT_LOCK,
    fingerprint: (tx) => calendarFingerprint(tx, 'ultimo_days'),
    contentStart: ULTIMO_START,
    lastDay: ultimoLastDay,
    async seed(tx, files, dryRun) {
      const days = files.map((raw, i) => ultimo.parseDayFile(label(raw, i), raw));
      ultimo.assertCalendar(days);
      return summary(await ultimo.seedDaysTx(tx, days, { appendOnly: true, dryRun, allowCorrection: false, allowPoolOverlap: false }));
    },
  },
  minuto: {
    table: 'minuto_days',
    contentLock: minuto.MINUTO_CONTENT_LOCK,
    fingerprint: (tx) => calendarFingerprint(tx, 'minuto_days'),
    contentStart: MINUTO_START,
    lastDay: minutoLastDay,
    async seed(tx, files, dryRun) {
      const days = files.map((raw, i) => minuto.parseDayFile(label(raw, i), raw));
      minuto.assertCalendar(days);
      return summary(await minuto.seedDaysTx(tx, days, { appendOnly: true, dryRun, allowCorrection: false, allowPoolOverlap: false }));
    },
  },
};
