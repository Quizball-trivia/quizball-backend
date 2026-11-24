import type { Sql } from 'postgres';
import { normalizeNameGreek } from '../footballers/footballers.text.js';
import type { EntityKind, TenableEntity } from './tenable.identify.js';

const PAGE = 20_000;

/**
 * The release's Greek names under a pin, exactly like the Russian ones (tenable.russian.ts): players from a word-game
 * Greek version (with its alternative spellings as aliases), managers, clubs and nations from a Greek name set. Null when
 * they do not name every entity of the release (a partial set is never used). Fame and a missing Greek qualifier are the
 * release's own.
 */
export interface GreekPin { players_version: string | null; names_version: string | null }

/** The versions the release is pinned to, or null while it has none. */
export async function greekPinOf(db: Sql, kind: EntityKind, releaseId: string): Promise<GreekPin | null> {
  const [pin] = await db<GreekPin[]>`SELECT players_version, names_version FROM tenable_el_releases WHERE kind = ${kind} AND release_id = ${releaseId}`;
  return pin ?? null;
}

/** `pin`: the release's pin, or the versions it would be pinned to (the pinning script checks them before writing it). */
export async function greekRows(db: Sql, kind: EntityKind, releaseId: string, latin: readonly TenableEntity[], pin: GreekPin): Promise<TenableEntity[] | null> {
  const byEid = new Map(latin.map((e) => [e.eid, e]));
  const out: TenableEntity[] = [];
  let after = '';
  for (;;) {
    const page = kind === 'player'
      ? await db<Array<{ eid: string; name: string; known: string; aliases: string[]; qualifier: string | null }>>`
          SELECT n.pid AS eid, n.name_el AS name, n.game_name_el AS known, n.aliases_el AS aliases, NULL::text AS qualifier
          FROM wordgame_el_names n JOIN wordgame_players p ON p.release_id = ${releaseId} AND p.pid = n.pid
          WHERE n.version = ${pin.players_version} AND n.pid > ${after} ORDER BY n.pid LIMIT ${PAGE}`
      : await db<Array<{ eid: string; name: string; known: string; aliases: string[]; qualifier: string | null }>>`
          SELECT n.eid, n.name_el AS name, n.known_el AS known, n.aliases_el AS aliases, n.qualifier_el AS qualifier
          FROM tenable_el_names n JOIN tenable_entities e ON e.release_id = ${releaseId} AND e.kind = n.kind AND e.eid = n.eid
          WHERE n.version = ${pin.names_version} AND n.kind = ${kind} AND n.eid > ${after} ORDER BY n.eid LIMIT ${PAGE}`;
    for (const row of page) {
      const own = byEid.get(row.eid);
      if (own) out.push({ eid: row.eid, name: row.name, known: row.known, fame: own.fame, aliases: row.aliases, qualifier: row.qualifier ?? own.qualifier });
    }
    if (page.length < PAGE) break;
    after = page[page.length - 1].eid;
  }
  if (out.length !== latin.length) return null;
  // Two entities spelt apart in Latin can be written alike in Greek: such a namesake is told apart in the suggestions by
  // its own spelling.
  const holders = new Map<string, TenableEntity[]>();
  for (const e of out) {
    const key = normalizeNameGreek(e.name);
    holders.set(key, [...(holders.get(key) ?? []), e]);
  }
  return out.map((e) => {
    const twins = holders.get(normalizeNameGreek(e.name))!;
    if (twins.length < 2) return e;
    const own = byEid.get(e.eid)!.name;
    return { ...e, qualifier: e.qualifier ? `${e.qualifier} · ${own}` : own };
  });
}
