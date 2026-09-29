import { CLUES_PER_ROUND, ROUNDS_PER_DAY } from './pistas.constants.js';
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
  return { es: v.es as string, en: v.en as string, ka: v.ka as string, tr: v.tr as string };
}

function clue(value: unknown): Clue | null {
  const c = (value ?? {}) as { kind?: unknown; icon?: unknown; text?: unknown };
  if (!CLUE_KINDS.includes(c.kind as ClueKind)) return null;
  if (c.icon !== null && !isText(c.icon)) return null;
  const text = localized(c.text);
  return text ? { kind: c.kind as ClueKind, icon: c.icon as string | null, text } : null;
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
    indexed.push({ id: raw.id, clues: clues as Clue[], display, accepted });
  }
  return { day: row.day, number: row.number, contentVersion: row.contentVersion, rounds: indexed };
}

/** A fresh copy for a response, field by field. */
export const copyClue = (c: Clue): Clue => ({ kind: c.kind, icon: c.icon, text: { es: c.text.es, en: c.text.en, ka: c.text.ka, tr: c.text.tr } });
export const copyText = (t: LocalizedText): LocalizedText => ({ es: t.es, en: t.en, ka: t.ka, tr: t.tr });

export interface ContentSource {
  /** Changes whenever pistas_days changes (a seed); cheap enough to ask every few seconds. */
  fingerprint(): Promise<string>;
  load(): Promise<PistasDayRow[]>;
}

export interface ContentLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ContentStore {
  /** Days in serving form; re-read from the database only when its fingerprint changes. */
  get(): Promise<ContentIndex>;
  /** The next get() re-checks the database instead of waiting out the refresh interval. */
  invalidate(): void;
}

export function createContentStore(source: ContentSource, opts: { refreshMs: number; now: () => number; log: ContentLog }): ContentStore {
  let cached: { fingerprint: string; index: ContentIndex; checkedAt: number } | null = null;
  let inflight: Promise<ContentIndex> | null = null;

  async function refresh(): Promise<ContentIndex> {
    const fingerprint = await source.fingerprint();
    if (cached && cached.fingerprint === fingerprint) {
      cached.checkedAt = opts.now();
      return cached.index;
    }
    const index = new Map<string, IndexedDay>();
    for (const row of await source.load()) {
      const day = indexDay(row);
      if (day) index.set(row.day, day);
      else opts.log.error({ day: row.day }, 'Pistas day has malformed content; it is not served');
    }
    cached = { fingerprint, index, checkedAt: opts.now() };
    return index;
  }

  return {
    async get() {
      if (cached && opts.now() - cached.checkedAt < opts.refreshMs) return cached.index;
      inflight ??= refresh().finally(() => { inflight = null; });
      try {
        return await inflight;
      } catch (error) {
        // A failed re-check keeps serving what was loaded; with nothing loaded yet the request fails.
        if (!cached) throw error;
        opts.log.warn({ err: error }, 'Pistas content refresh failed; serving the previous copy');
        cached.checkedAt = opts.now();
        return cached.index;
      }
    },
    invalidate() {
      if (cached) cached.checkedAt = Number.NEGATIVE_INFINITY;
    },
  };
}
