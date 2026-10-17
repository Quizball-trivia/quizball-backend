import type { Sql } from 'postgres';
import { normalizeNameCyrillic } from '../footballers/footballers.text.js';
import type { EntityKind, TenableEntity } from './tenable.identify.js';

const PAGE = 20_000;

/**
 * The release's Russian names under a pin, or null when they do not name every entity of it (a partial set is never used). Fame (every "best known" decision) and a missing Russian qualifier are
 * the release's own.
 */
export interface RussianPin { players_version: string | null; names_version: string | null }

/** The versions the release is pinned to, or null while it has none. */
export async function russianPinOf(db: Sql, kind: EntityKind, releaseId: string): Promise<RussianPin | null> {
  const [pin] = await db<RussianPin[]>`SELECT players_version, names_version FROM tenable_ru_releases WHERE kind = ${kind} AND release_id = ${releaseId}`;
  return pin ?? null;
}

/** `pin`: the release's pin, or the versions it would be pinned to (the pinning script checks them before writing it). */
export async function russianRows(db: Sql, kind: EntityKind, releaseId: string, latin: readonly TenableEntity[], pin: RussianPin): Promise<TenableEntity[] | null> {
  const byEid = new Map(latin.map((e) => [e.eid, e]));
  const out: TenableEntity[] = [];
  let after = '';
  for (;;) {
    const page = kind === 'player'
      ? await db<Array<{ eid: string; name: string; known: string; aliases: string[]; qualifier: string | null }>>`
          SELECT n.pid AS eid, n.name_ru AS name, n.game_name_ru AS known, '{}'::text[] AS aliases, NULL::text AS qualifier
          FROM wordgame_ru_names n JOIN wordgame_players p ON p.release_id = ${releaseId} AND p.pid = n.pid
          WHERE n.version = ${pin.players_version} AND n.pid > ${after} ORDER BY n.pid LIMIT ${PAGE}`
      : await db<Array<{ eid: string; name: string; known: string; aliases: string[]; qualifier: string | null }>>`
          SELECT n.eid, n.name_ru AS name, n.known_ru AS known, n.aliases_ru AS aliases, n.qualifier_ru AS qualifier
          FROM tenable_ru_names n JOIN tenable_entities e ON e.release_id = ${releaseId} AND e.kind = n.kind AND e.eid = n.eid
          WHERE n.version = ${pin.names_version} AND n.kind = ${kind} AND n.eid > ${after} ORDER BY n.eid LIMIT ${PAGE}`;
    for (const row of page) {
      const own = byEid.get(row.eid);
      if (own) out.push({ eid: row.eid, name: row.name, known: row.known, fame: own.fame, aliases: row.aliases, qualifier: row.qualifier ?? own.qualifier });
    }
    if (page.length < PAGE) break;
    after = page[page.length - 1].eid;
  }
  if (out.length !== latin.length) return null;
  // Two entities spelt apart in Latin can sound the same in Russian ("Christian" / "Kristian"): such a namesake is told
  // apart in the suggestions by its own spelling.
  const holders = new Map<string, TenableEntity[]>();
  for (const e of out) {
    const key = normalizeNameCyrillic(e.name);
    holders.set(key, [...(holders.get(key) ?? []), e]);
  }
  return out.map((e) => {
    const twins = holders.get(normalizeNameCyrillic(e.name))!;
    if (twins.length < 2) return e;
    const own = byEid.get(e.eid)!.name;
    return { ...e, qualifier: e.qualifier ? `${e.qualifier} · ${own}` : own };
  });
}
