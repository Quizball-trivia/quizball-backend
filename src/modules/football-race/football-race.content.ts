import { createDailyContentStore, type ContentLog, type ContentSource as DailyContentSource, type ContentStore as DailyContentStore } from '../daily/daily.content.js';
import { dayRaceSchema, type DayRace, type FootballRaceDayRow } from './football-race.types.js';

export interface IndexedDay { day: string; number: number; contentVersion: number; race: DayRace }
export type ContentIndex = ReadonlyMap<string, IndexedDay>;

/** A stored day in serving form; null when the row is malformed (the seed validates fully, this only keeps a bad row out). */
export function indexDay(row: FootballRaceDayRow): IndexedDay | null {
  const race = dayRaceSchema.safeParse(row.race);
  return race.success ? { day: row.day, number: row.number, contentVersion: row.contentVersion, race: race.data } : null;
}

export type { ContentLog } from '../daily/daily.content.js';
export type ContentSource = DailyContentSource<FootballRaceDayRow>;
export type ContentStore = DailyContentStore<IndexedDay>;

export function createContentStore(source: ContentSource, opts: { refreshMs: number; now: () => number; log: ContentLog }): ContentStore {
  return createDailyContentStore(source, indexDay, { ...opts, label: 'Football Horserace' });
}
