import { createDailyContentStore, type ContentLog, type ContentSource as DailyContentSource, type ContentStore as DailyContentStore } from '../daily/daily.content.js';
import { CLUES_PER_ROUND, ROUNDS_PER_DAY } from './pistas.constants.js';
import { CLUE_ORDER_FROM } from './pistas.days.js';
import { normalizeAnswer } from './pistas.normalize.js';
import { CLUE_KINDS, PISTAS_LOCALES, type Clue, type ClueKind, type LocalizedText, type PistasDayRow } from './pistas.types.js';

export interface IndexedRound {
  id: string;
  /** Built field by field, so a stray field in the stored JSON can never reach a response. */
  clues: readonly Clue[];
  display: LocalizedText;
  /** Normalised accepted answers. */
  accepted: ReadonlySet<string>;
}

export interface IndexedDay {
  day: string;
  number: number;
  contentVersion: number;
  rounds: IndexedRound[];
}

export type ContentIndex = ReadonlyMap<string, IndexedDay>;

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function localized(value: unknown): LocalizedText | null {
  const v = (value ?? {}) as Record<string, unknown>;
  if (!PISTAS_LOCALES.every((locale) => isText(v[locale]))) return null;
  return { es: v.es as string, en: v.en as string, ka: v.ka as string, tr: v.tr as string, ...(isText(v.ru) ? { ru: v.ru } : {}), ...(isText(v.pt) ? { pt: v.pt } : {}), ...(isText(v.de) ? { de: v.de } : {}), ...(isText(v.fr) ? { fr: v.fr } : {}) };
}

function clue(value: unknown): Clue | null {
  const c = (value ?? {}) as { kind?: unknown; icon?: unknown; text?: unknown };
  if (!CLUE_KINDS.includes(c.kind as ClueKind)) return null;
  if (c.icon !== null && !isText(c.icon)) return null;
  const text = localized(c.text);
  return text ? { kind: c.kind as ClueKind, icon: c.icon as string | null, text } : null;
}

/** Profile chips by how much they narrow the field next to a fact: position and decade first, preferred foot last. */
const PROFILE_PRIORITY: Record<Exclude<ClueKind, 'fact'>, number> = { position: 0, decade: 1, confed: 2, foot: 3 };
/** The easiest facts (the content's last ones, hardest-to-easiest) stay the closing clues. */
const CLOSING_FACTS = 2;

/**
 * Serving order of a round's clues. The content writes the broad profile chips (confederation, position, foot,
 * decade) first and the facts hardest-to-easiest after them, so a round used to open on "European, forward,
 * 1990s" guesswork. Here a specific fact always opens the round, each profile chip then follows a fact as a
 * narrowing aid, and the easiest facts still close it: f1 position f2 decade f3 confed f4 foot f5 f6.
 * Facts keep their relative order (the difficulty ramp is content); a round without facts keeps its order.
 * Idempotent, so content that is already written in this order is served unchanged.
 */
export function orderClues<T extends { kind: ClueKind }>(clues: readonly T[]): T[] {
  const facts = clues.filter((c) => c.kind === 'fact');
  if (facts.length === 0) return [...clues];
  const profile = clues.filter((c) => c.kind !== 'fact')
    .map((c, i) => ({ c, i }))
    .sort((a, b) => PROFILE_PRIORITY[a.c.kind as Exclude<ClueKind, 'fact'>] - PROFILE_PRIORITY[b.c.kind as Exclude<ClueKind, 'fact'>] || a.i - b.i)
    .map(({ c }) => c);
  const closing = facts.slice(Math.max(1, facts.length - CLOSING_FACTS));
  const middle = facts.slice(1, facts.length - closing.length);
  const out: T[] = [facts[0]];
  for (const chip of profile) {
    out.push(chip);
    const fact = middle.shift();
    if (fact) out.push(fact);
  }
  return [...out, ...middle, ...closing];
}

/** A stored day in serving form; null when the row is malformed (the seed validates fully, this only keeps a bad row out). */
export function indexDay(row: PistasDayRow): IndexedDay | null {
  const rounds = row.rounds as unknown;
  if (!Array.isArray(rounds) || rounds.length !== ROUNDS_PER_DAY) return null;
  const indexed: IndexedRound[] = [];
  for (const raw of rounds as Array<{ id?: unknown; clues?: unknown; answer?: { display?: unknown; accepted?: unknown } }>) {
    if (!isText(raw?.id) || !Array.isArray(raw.clues) || raw.clues.length !== CLUES_PER_ROUND) return null;
    const clues = raw.clues.map(clue);
    if (clues.some((c) => c === null)) return null;
    const display = localized(raw.answer?.display);
    const acceptedRaw = raw.answer?.accepted;
    if (!display || !Array.isArray(acceptedRaw) || !acceptedRaw.every(isText)) return null;
    const accepted = new Set((acceptedRaw as string[]).map(normalizeAnswer).filter((a) => a.length > 0));
    if (accepted.size === 0) return null;
    // Days before CLUE_ORDER_FROM keep the stored order (runs may have been played on it); the order is not part of
    // contentVersion, which stays the stored row's so writes keep matching the database.
    const ordered = row.day >= CLUE_ORDER_FROM ? orderClues(clues as Clue[]) : (clues as Clue[]);
    indexed.push({ id: raw.id, clues: ordered, display, accepted });
  }
  return { day: row.day, number: row.number, contentVersion: row.contentVersion, rounds: indexed };
}

/** A fresh copy for a response, field by field. */
export const copyText = (t: LocalizedText): LocalizedText => ({ es: t.es, en: t.en, ka: t.ka, tr: t.tr, ...(t.ru ? { ru: t.ru } : {}), ...(t.pt ? { pt: t.pt } : {}), ...(t.de ? { de: t.de } : {}), ...(t.fr ? { fr: t.fr } : {}) });
export const copyClue = (c: Clue): Clue => ({ kind: c.kind, icon: c.icon, text: copyText(c.text) });

export type { ContentLog } from '../daily/daily.content.js';

export type ContentSource = DailyContentSource<PistasDayRow>;
export type ContentStore = DailyContentStore<IndexedDay>;

export function createContentStore(source: ContentSource, opts: { refreshMs: number; now: () => number; log: ContentLog }): ContentStore {
  return createDailyContentStore(source, indexDay, { ...opts, label: 'Pistas' });
}
