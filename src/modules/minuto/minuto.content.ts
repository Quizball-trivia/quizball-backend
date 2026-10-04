import { createDailyContentStore, type ContentLog, type ContentSource as DailyContentSource, type ContentStore as DailyContentStore } from '../daily/daily.content.js';
import { GOALS_PER_DAY } from './minuto.constants.js';
import { goalSchema, type MinutoGoal } from './minuto.goal.js';
import type { MinutoDayRow } from './minuto.types.js';

export interface IndexedDay {
  day: string;
  number: number;
  contentVersion: number;
  goals: MinutoGoal[];
}

export type ContentIndex = ReadonlyMap<string, IndexedDay>;

/** A stored day in serving form; null when the row is malformed (the seed validates fully, this only keeps a bad row out). */
export function indexDay(row: MinutoDayRow): IndexedDay | null {
  const goals = row.goals as unknown;
  if (!Array.isArray(goals) || goals.length !== GOALS_PER_DAY) return null;
  const parsed: MinutoGoal[] = [];
  for (const raw of goals) {
    const goal = goalSchema.safeParse(raw);
    if (!goal.success) return null;
    parsed.push(goal.data);
  }
  return { day: row.day, number: row.number, contentVersion: row.contentVersion, goals: parsed };
}

export type { ContentLog } from '../daily/daily.content.js';
export type ContentSource = DailyContentSource<MinutoDayRow>;
export type ContentStore = DailyContentStore<IndexedDay>;

export function createContentStore(source: ContentSource, opts: { refreshMs: number; now: () => number; log: ContentLog }): ContentStore {
  return createDailyContentStore(source, indexDay, { ...opts, label: 'Minuto' });
}
