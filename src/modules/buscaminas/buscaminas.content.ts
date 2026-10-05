import { rememberStoredDays } from '../daily/daily.content.js';
import { BUSCAMINAS_DIFFICULTIES, BUSCAMINAS_LOCALES, type BuscaminasDayRow, type BuscaminasDifficulty, type PublicBoard, type PublicRound } from './buscaminas.types.js';

export interface IndexedRound {
  id: string;
  cardIds: ReadonlySet<string>;
  okIds: ReadonlySet<string>;
  ok: string[];
  mines: string[];
}

export interface IndexedDay {
  day: string;
  contentVersion: number;
  rounds: IndexedRound[];
  /** Built field by field, so an `ok` flag (or any stray field) in the stored board can never reach a response. */
  board: PublicBoard;
}

export type ContentIndex = ReadonlyMap<string, IndexedDay>;

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** A stored day in serving form; null when the row is malformed (the seed script validates fully, this only keeps a bad row out). */
export function indexDay(row: BuscaminasDayRow): IndexedDay | null {
  const rounds = (row.board as { rounds?: unknown })?.rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) return null;
  const answers = (row.answers ?? {}) as Record<string, unknown>;
  const board: PublicRound[] = [];
  const indexed: IndexedRound[] = [];
  for (const raw of rounds as Array<Partial<PublicRound>>) {
    const fitting = answers[raw?.id ?? ''];
    if (!isText(raw?.id) || !Array.isArray(raw.cards) || !Array.isArray(fitting)) return null;
    if (!BUSCAMINAS_DIFFICULTIES.includes(raw.difficulty as BuscaminasDifficulty)) return null;
    const prompt = (raw.prompt ?? {}) as Record<string, unknown>;
    if (!BUSCAMINAS_LOCALES.every((locale) => isText(prompt[locale]))) return null;
    const cards = raw.cards.map((c) => ({ id: c?.id, name: c?.name, img: c?.img }));
    if (!cards.every((c) => isText(c.id) && isText(c.name) && isText(c.img))) return null;
    const cardIds = new Set(cards.map((c) => c.id as string));
    const okIds = new Set(fitting as string[]);
    if (cardIds.size !== cards.length || [...okIds].some((id) => !cardIds.has(id))) return null;
    board.push({
      id: raw.id,
      difficulty: raw.difficulty as BuscaminasDifficulty,
      prompt: { es: prompt.es as string, en: prompt.en as string, ka: prompt.ka as string, tr: prompt.tr as string },
      cards: cards as PublicRound['cards'],
    });
    indexed.push({
      id: raw.id,
      cardIds,
      okIds,
      ok: cards.filter((c) => okIds.has(c.id as string)).map((c) => c.id as string),
      mines: cards.filter((c) => !okIds.has(c.id as string)).map((c) => c.id as string),
    });
  }
  return {
    day: row.day,
    contentVersion: row.contentVersion,
    rounds: indexed,
    board: { day: row.day, number: row.number, contentVersion: row.contentVersion, rounds: board },
  };
}

export interface ContentSource {
  /** Changes whenever buscaminas_days changes (a seed); cheap enough to ask every few seconds. */
  fingerprint(): Promise<string>;
  load(): Promise<BuscaminasDayRow[]>;
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
    const rows = await source.load();
    for (const row of rows) {
      const day = indexDay(row);
      if (day) index.set(row.day, day);
      else opts.log.error({ day: row.day }, 'Buscaminas day has malformed content; it is not served');
    }
    rememberStoredDays(index, rows.map((row) => row.day));
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
        opts.log.warn({ err: error }, 'Buscaminas content refresh failed; serving the previous copy');
        cached.checkedAt = opts.now();
        return cached.index;
      }
    },
    invalidate() {
      if (cached) cached.checkedAt = Number.NEGATIVE_INFINITY;
    },
  };
}
