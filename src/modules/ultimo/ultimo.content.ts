import { createDailyContentStore, type ContentLog, type ContentSource, type ContentStore } from '../daily/daily.content.js';
import { CATEGORIES_PER_DAY } from './ultimo.constants.js';
import { ultimoCategorySchema, type UltimoCategory } from './ultimo.match.js';
import type { UltimoDayRow } from './ultimo.types.js';

export interface IndexedDay {
  day: string;
  number: number;
  contentVersion: number;
  /** Parsed field by field by the schema, so a stray field in the stored JSON can never reach a response. */
  categories: UltimoCategory[];
}

export type ContentIndex = ReadonlyMap<string, IndexedDay>;

/** A stored day in serving form; null when the row is malformed (the seed validates fully, this only keeps a bad row out). */
export function indexDay(row: UltimoDayRow): IndexedDay | null {
  if (!Array.isArray(row.categories) || row.categories.length !== CATEGORIES_PER_DAY) return null;
  const categories: UltimoCategory[] = [];
  for (const raw of row.categories) {
    const parsed = ultimoCategorySchema.safeParse(raw);
    if (!parsed.success) return null;
    categories.push(parsed.data);
  }
  return { day: row.day, number: row.number, contentVersion: row.contentVersion, categories };
}

export function createContentStore(source: ContentSource<UltimoDayRow>, opts: { refreshMs: number; now: () => number; log: ContentLog }): ContentStore<IndexedDay> {
  return createDailyContentStore(source, indexDay, { ...opts, label: 'Último en pie' });
}
