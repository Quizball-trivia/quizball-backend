import { sql, type TransactionSql } from '../../../../db/index.js';
import { raceTournamentDataSchema, type RaceTournamentData } from './football-race.rules.js';

/** Parsed tournaments kept in memory: every tournament of the current release and the previous one fit. */
const MAX_CACHED = 24;
const loaded = new Map<string, RaceTournamentData>();
/** Pooled loads in flight; concurrent pooled callers share one. */
const pending = new Map<string, Promise<RaceTournamentData>>();

async function read(db: typeof sql, release: string, tournament: string): Promise<RaceTournamentData> {
  const key = `${release}/${tournament}`;
  const [row] = await db<{ payload: unknown }[]>`
    SELECT payload FROM football_race_tournaments WHERE release = ${release} AND tournament = ${tournament}
  `;
  if (!row) throw new Error(`football_race: no tournament ${key}`);
  const data = raceTournamentDataSchema.parse(row.payload);
  if (data.release !== release || data.tournament.id !== tournament) throw new Error(`football_race: ${key} holds ${data.release}/${data.tournament.id}`);
  loaded.delete(key);
  loaded.set(key, data);
  while (loaded.size > MAX_CACHED) loaded.delete(loaded.keys().next().value!);
  return data;
}

/**
 * One tournament of a release, parsed with the strict schema. Releases are immutable, so a cached copy never goes
 * stale; an old release stays readable (a match started on it keeps it) even after a newer one is enabled. `tx`: the
 * caller holds a match lock, so a cold tournament is read through that transaction, never by waiting on a pooled load
 * (which may itself be waiting for the connections those locks hold).
 */
export async function loadRaceTournament(release: string, tournament: string, tx?: TransactionSql): Promise<RaceTournamentData> {
  const key = `${release}/${tournament}`;
  const hit = loaded.get(key);
  if (hit) {
    loaded.delete(key);
    loaded.set(key, hit);
    return hit;
  }
  if (tx) return read(tx as unknown as typeof sql, release, tournament);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const load = read(sql, release, tournament).finally(() => pending.delete(key));
  pending.set(key, load);
  return load;
}

/** Loads every tournament of the enabled releases (at boot), so a match never waits on a cold load under its lock. */
export async function warmRaceTournaments(): Promise<number> {
  const rows = await sql<{ release: string; tournament: string }[]>`
    SELECT t.release, t.tournament FROM football_race_tournaments t
    JOIN football_race_releases r USING (release) WHERE r.enabled
    ORDER BY r.created_at DESC, t.tournament
  `;
  // One at a time: at boot the database admission gate is shared with every other warm-up, and a burst is refused.
  let loaded = 0;
  for (const r of rows.slice(0, MAX_CACHED)) {
    try {
      await loadRaceTournament(r.release, r.tournament);
    } catch {
      await new Promise((done) => setTimeout(done, 2_000));
      await loadRaceTournament(r.release, r.tournament);
    }
    loaded += 1;
  }
  return loaded;
}

/** Tests only. */
export const clearRaceTournamentCache = () => { loaded.clear(); pending.clear(); };
