import { z } from 'zod';
import { logger } from '../../core/logger.js';
import { sql, withStatementTimeout, type TransactionSql } from '../../db/index.js';
import { createDailyContentStore } from '../daily/daily.content.js';
import { CONTENT_REFRESH_MS } from '../wordgame-daily/wordgame-daily.shared.js';
import { draftPackSchema, universeOf, type ServerUniverse } from './draft.universe.js';
import { FORMATIONS, type Era, type FormationId } from './draft.rules.js';

const READ_MS = 8_000;
const PACK_READ_MS = 30_000;
const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;

export const draftEras = ['all', 'modern', 'legends'] as const;
export const draftFormations = Object.keys(FORMATIONS) as FormationId[];

export const draftDaySetupSchema = z.object({
  release: z.string().min(1).max(40),
  leagueId: z.string().min(1).max(20),
  era: z.enum(draftEras),
  formation: z.enum(draftFormations as [FormationId, ...FormationId[]]),
  seed: z.string().min(8).max(80),
}).strict();
export type DraftDaySetup = z.infer<typeof draftDaySetupSchema> & { era: Era };

export interface DraftDayRow { day: string; number: number; contentVersion: number; setup: unknown }
export interface IndexedDraftDay { day: string; number: number; contentVersion: number; setup: DraftDaySetup }

/** A pack is about 3 MB: read whole once per release per process, shared by everyone waiting, and dropped if the read fails so the next call retries. */
const packs = new Map<string, Promise<ServerUniverse>>();
const readyPacks = new Map<string, ServerUniverse>();

async function readPack(release: string): Promise<ServerUniverse> {
  const rows = await withStatementTimeout((tx) => exec(tx)<Array<{ pack: unknown }>>`SELECT pack FROM draft_packs WHERE release = ${release}`, PACK_READ_MS);
  if (!rows[0]) throw new Error(`Football Draft release ${release} is not seeded`);
  return universeOf(draftPackSchema.parse(rows[0].pack));
}

export const draftPacks = {
  get(release: string): Promise<ServerUniverse> {
    const cached = packs.get(release);
    if (cached) return cached;
    const load = readPack(release).then((u) => { readyPacks.set(release, u); return u; });
    packs.set(release, load);
    load.catch(() => packs.delete(release));
    return load;
  },
  /** Only what has finished loading: never waits, so it is safe under a lock. */
  ready: (release: string): ServerUniverse | null => readyPacks.get(release) ?? null,
  /** Tests only. */
  set(release: string, universe: ServerUniverse): void {
    readyPacks.set(release, universe);
    packs.set(release, Promise.resolve(universe));
  },
};

let activeCache: { release: string; at: number } | null = null;
const ACTIVE_CACHE_MS = 60_000;

/** The release new free runs and rooms are dealt from. */
export async function activeRelease(now = Date.now()): Promise<string> {
  if (activeCache && now - activeCache.at < ACTIVE_CACHE_MS) return activeCache.release;
  const rows = await withStatementTimeout((tx) => exec(tx)<Array<{ release: string }>>`SELECT release FROM draft_packs WHERE active ORDER BY created_at DESC LIMIT 1`, READ_MS);
  if (!rows[0]) throw new Error('No active Football Draft release');
  activeCache = { release: rows[0].release, at: now };
  return rows[0].release;
}
export const setActiveReleaseForTests = (release: string | null): void => { activeCache = release ? { release, at: Date.now() } : null; };

export const draftDayReads = {
  daysFingerprint: (): Promise<string> =>
    withStatementTimeout(async (tx) => {
      const [row] = await exec(tx)<Array<{ fingerprint: string }>>`SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') AS fingerprint FROM draft_days`;
      return row.fingerprint;
    }, READ_MS),
  loadDays: (): Promise<DraftDayRow[]> =>
    withStatementTimeout((tx) => exec(tx)<DraftDayRow[]>`SELECT day::text AS day, number, content_version::float8 AS "contentVersion", setup FROM draft_days ORDER BY day`, READ_MS),
};

export function indexDay(row: DraftDayRow): IndexedDraftDay | null {
  const parsed = draftDaySetupSchema.safeParse(row.setup);
  return parsed.success ? { day: row.day, number: row.number, contentVersion: row.contentVersion, setup: parsed.data } : null;
}

export const draftDayContent = createDailyContentStore(
  { fingerprint: () => draftDayReads.daysFingerprint(), load: () => draftDayReads.loadDays() },
  indexDay,
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger, label: 'Football Draft' },
);
