/**
 * Content gaps, pure: typed answers a game could not judge well, aggregated in memory per (game, board, judging context,
 * verdict, normalised text) until the recorder flushes them. No I/O and no clock here.
 */
export const GAP_VERDICTS = ['unknown', 'uncovered', 'ambiguous', 'miss', 'reported'] as const;
export type GapVerdict = (typeof GAP_VERDICTS)[number];
export const GAP_MODES = ['daily', 'room', 'duel', 'realtime', 'practice'] as const;
export type GapMode = (typeof GAP_MODES)[number];
export const GAP_LOCALES = ['es', 'en', 'ka', 'tr', 'ru', 'pt', 'de', 'fr'] as const;
export type GapLocale = (typeof GAP_LOCALES)[number] | 'xx';

export interface GapObservation {
  game: string;
  mode: GapMode;
  /** The content unit judged against: a category, list, pair, board cell, round. */
  boardKey: string;
  /** What judged it: release, content revision, matcher version. */
  context: string;
  verdict: GapVerdict;
  /** What the player typed (raw). */
  text: string;
  locale?: string | null;
  /** Whom the matcher took the text for, when it did. */
  resolvedId?: string | null;
  /** The people an ambiguous text could be. */
  candidateIds?: readonly string[] | null;
}

/** What a game's judge saw; the runtime around it adds the mode and the player's locale. */
export type GapSeen = Omit<GapObservation, 'mode' | 'locale'>;

/**
 * Runs a gap diagnostic (inside a game's own transaction step, where a throw would roll back a valid move) and turns any
 * failure into "no gap". Game rule errors never come from here: callers keep the game's own call outside.
 */
export function safeGap<T>(diagnose: () => T | null): T | null {
  try {
    return diagnose();
  } catch {
    return null;
  }
}

export interface GapRow {
  game: string;
  mode: GapMode;
  board_key: string;
  context_fp: string;
  verdict: GapVerdict;
  norm: string;
  resolved_id: string | null;
  candidate_ids: string[] | null;
  n: number;
  /** locale → up to SAMPLES_PER_LOCALE distinct raw typings. */
  samples: Record<string, string[]>;
}

export const LIMITS = {
  keys: 5_000,
  /** Serialised size the buffer may hold before new keys are refused (existing keys keep counting). */
  bytes: 4 * 1024 * 1024,
  norm: 80,
  typed: 160,
  boardKey: 160,
  context: 200,
  game: 40,
  id: 80,
  candidates: 10,
  samplesPerLocale: 5,
} as const;

/**
 * One grouping form for every game (each game keeps its own matcher): case and accents folded, Georgian and Cyrillic
 * kept, punctuation and spacing collapsed. Turkish İ/ı fold to i like the matchers do.
 */
export function normalizeGapText(text: string): string {
  const folded = wellFormed(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return Array.from(folded).slice(0, LIMITS.norm).join('').trim();
}

/** Contact details never belong in an answer: such text is not kept at all (checked on the NFKC form, so full-width
 * forms count too, and on the whole text before anything is clipped). */
const PRIVATE = /@|\p{Nd}[\p{Nd}\s().+\-]{6,}\p{Nd}|https?:\/\/|www\./iu;
export const looksPrivate = (text: string): boolean => PRIVATE.test(text.normalize('NFKC'));

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const wellFormed = (text: string) => text.replace(/\u0000/g, '').replace(LONE_SURROGATE, '\uFFFD');

/** Text PostgreSQL can store: no NUL, no lone surrogates; clipped by code point, never inside a pair. */
export function storable(text: string, max: number): string {
  const clean = wellFormed(text);
  const points = Array.from(clean);
  return points.length > max ? points.slice(0, max).join('') : clean;
}

/** The player's language when the game knows it; else what the script says (Georgian, Cyrillic); else unknown. */
const asLocale = (value: string | null | undefined, typed: string): GapLocale => {
  if ((GAP_LOCALES as readonly string[]).includes(value ?? '')) return value as GapLocale;
  if (/[\u10A0-\u10FF\u1C90-\u1CBF]/.test(typed)) return 'ka';
  if (/[\u0400-\u04FF]/.test(typed)) return 'ru';
  return 'xx';
};

const clip = (value: string, max: number) => storable(value, max);

export interface BufferStats { keys: number; recorded: number; dropped: number; refused: number }

/** A string's size once serialised as JSON (escapes included). */
const jsonBytes = (value: string) => Buffer.byteLength(JSON.stringify(value));

/** Fixed serialised cost of a row beyond its key and samples (field names, numbers). */
const ROW_OVERHEAD = 200;

export class GapBuffer {
  private rows = new Map<string, GapRow>();
  private bytes = 0;
  private dropped = 0;
  private refused = 0;
  private recorded = 0;

  constructor(private readonly maxKeys: number = LIMITS.keys, private readonly maxBytes: number = LIMITS.bytes) {}

  /** Adds one observation; false when it was refused (empty, private-looking) or dropped (buffer full). */
  add(o: GapObservation): boolean {
    // Screened as given and as it would be stored (removing a NUL can join digits into a number).
    if (looksPrivate(o.text) || looksPrivate(wellFormed(o.text))) {
      this.refused += 1;
      return false;
    }
    const typed = storable(o.text.trim(), LIMITS.typed);
    const norm = normalizeGapText(typed);
    if (!norm || !o.game || !o.boardKey || !o.context) {
      this.refused += 1;
      return false;
    }
    const game = clip(o.game, LIMITS.game);
    const boardKey = clip(o.boardKey, LIMITS.boardKey);
    const context = clip(o.context, LIMITS.context);
    const key = JSON.stringify([game, boardKey, context, o.verdict, norm]);
    let row = this.rows.get(key);
    if (!row) {
      if (this.rows.size >= this.maxKeys || this.bytes >= this.maxBytes) {
        this.dropped += 1;
        return false;
      }
      const size = jsonBytes(key) * 2 + ROW_OVERHEAD;
      if (!this.fits(size)) {
        this.dropped += 1;
        return false;
      }
      row = { game, mode: o.mode, board_key: boardKey, context_fp: context, verdict: o.verdict, norm, resolved_id: null, candidate_ids: null, n: 0, samples: {} };
      this.rows.set(key, row);
      this.bytes += size;
    }
    row.n += 1;
    // Each allocation is reserved by its encoded size first: past the budget an existing key still counts, nothing more.
    if (o.resolvedId && !row.resolved_id) {
      const id = clip(o.resolvedId, LIMITS.id);
      const size = jsonBytes(id) + 16;
      if (this.fits(size)) { row.resolved_id = id; this.bytes += size; }
    }
    if (o.candidateIds && o.candidateIds.length > 0 && !row.candidate_ids) {
      const ids = o.candidateIds.slice(0, LIMITS.candidates).map((id) => clip(id, LIMITS.id));
      const size = ids.reduce((sum, id) => sum + jsonBytes(id) + 2, 16);
      if (this.fits(size)) { row.candidate_ids = ids; this.bytes += size; }
    }
    const locale = asLocale(o.locale, typed);
    const list = row.samples[locale];
    if ((list?.length ?? 0) < LIMITS.samplesPerLocale && !list?.includes(typed)) {
      const size = jsonBytes(typed) + 4 + (list ? 0 : 16);
      if (this.fits(size)) {
        (row.samples[locale] ??= []).push(typed);
        this.bytes += size;
      }
    }
    this.recorded += 1;
    return true;
  }

  private fits(size: number): boolean {
    return this.bytes + size <= this.maxBytes;
  }

  /** Hands over everything buffered (sorted by key, the lock order the flush uses) and starts empty. */
  drain(): GapRow[] {
    const entries = [...this.rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    this.rows = new Map();
    this.bytes = 0;
    return entries.map(([, row]) => row);
  }

  /** Counters since the last call (they reset), plus the keys waiting now. */
  takeStats(): BufferStats {
    const stats = { keys: this.rows.size, recorded: this.recorded, dropped: this.dropped, refused: this.refused };
    this.recorded = 0;
    this.dropped = 0;
    this.refused = 0;
    return stats;
  }
}

/** Splits rows into flush chunks bounded by count and by serialised size. */
export function chunkRows(rows: readonly GapRow[], maxRows = 500, maxBytes = 256 * 1024): GapRow[][] {
  const chunks: GapRow[][] = [];
  let current: GapRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (current.length > 0 && (current.length >= maxRows || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
