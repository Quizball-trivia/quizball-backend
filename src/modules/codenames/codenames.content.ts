import { createDailyContentStore, type ContentLog, type ContentSource as DailyContentSource, type ContentStore as DailyContentStore } from '../daily/daily.content.js';
import { dayBoardSchema, type CodenamesDayRow, type DayBoard } from './codenames.types.js';

export interface IndexedDay { day: string; number: number; contentVersion: number; board: DayBoard }
export type ContentIndex = ReadonlyMap<string, IndexedDay>;

/** A stored day in serving form; null when the row is malformed (the seed validates fully, this only keeps a bad row out). */
export function indexDay(row: CodenamesDayRow): IndexedDay | null {
  const board = dayBoardSchema.safeParse(row.board);
  return board.success ? { day: row.day, number: row.number, contentVersion: row.contentVersion, board: board.data } : null;
}

export type { ContentLog } from '../daily/daily.content.js';
export type ContentSource = DailyContentSource<CodenamesDayRow>;
export type ContentStore = DailyContentStore<IndexedDay>;

export function createContentStore(source: ContentSource, opts: { refreshMs: number; now: () => number; log: ContentLog }): ContentStore {
  return createDailyContentStore(source, indexDay, { ...opts, label: 'Football Codenames' });
}
