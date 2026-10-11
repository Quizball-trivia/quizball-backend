import { z } from 'zod';
import { createDailyContentStore, type ContentLog, type ContentSource as DailyContentSource, type ContentStore as DailyContentStore } from '../daily/daily.content.js';
import type { GridDailyDayRow } from './grid-daily.types.js';

export interface IndexedDay {
  day: string;
  number: number;
  contentVersion: number;
  boardId: string;
}

export type ContentIndex = ReadonlyMap<string, IndexedDay>;

// `checksum` (the board's content checksum) keeps the board out of online play even after a re-release gives
// the same content a new id; days seeded before it was recorded simply lack it.
const boardSchema = z.object({ boardId: z.string().uuid(), checksum: z.string().min(32).max(128).optional() });

/** Reserved by the seed script and not yet published: online play leaves the board alone, the daily game does not serve it. */
export function isReservedDay(row: Pick<GridDailyDayRow, 'board'>): boolean {
  return typeof row.board === 'object' && row.board !== null && 'reserved' in row.board;
}

/** A stored day in serving form; null when the row is malformed. */
export function indexDay(row: GridDailyDayRow): IndexedDay | null {
  const board = boardSchema.safeParse(row.board);
  if (!board.success) return null;
  return { day: row.day, number: row.number, contentVersion: row.contentVersion, boardId: board.data.boardId };
}

export type ContentSource = DailyContentSource<GridDailyDayRow>;
export type ContentStore = DailyContentStore<IndexedDay>;

export function createContentStore(source: ContentSource, opts: { refreshMs: number; now: () => number; log: ContentLog }): ContentStore {
  return createDailyContentStore(source, indexDay, { ...opts, label: 'Daily grid' });
}
