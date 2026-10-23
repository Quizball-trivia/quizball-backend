import type { Sql } from 'postgres';
import type { EntityKind, TenableEntity } from './tenable.identify.js';

/** Kinds whose names change across Latin-script languages ("Germany" / "Alemanha"); people keep their names. */
export const ALIAS_KINDS: ReadonlySet<EntityKind> = new Set(['club', 'nation']);

/** The alias set versions a release is pinned to, one per language, oldest pin first; empty while it has none. */
export async function aliasPinsOf(db: Sql, kind: EntityKind, releaseId: string): Promise<string[]> {
  if (!ALIAS_KINDS.has(kind)) return [];
  const pins = await db<Array<{ version: string }>>`
    SELECT version FROM tenable_alias_releases WHERE kind = ${kind} AND release_id = ${releaseId} ORDER BY created_at, locale`;
  return pins.map((p) => p.version);
}

/**
 * The release's entities with the pinned sets' spellings added to their aliases (Latin script, so the same directory
 * reads them: a Portuguese "Alemanha" is judged like a Spanish "Alemania"). `versions`: the release's pins, or the set a
 * pinning script is about to check.
 */
export async function withAliases(db: Sql, kind: EntityKind, entities: readonly TenableEntity[], versions: readonly string[]): Promise<TenableEntity[]> {
  if (!ALIAS_KINDS.has(kind) || versions.length === 0) return [...entities];
  const rows = await db<Array<{ eid: string; aliases: string[] }>>`
    SELECT eid, aliases FROM tenable_aliases WHERE version = ANY(${versions as string[]}) AND kind = ${kind}`;
  return mergeAliases(entities, rows);
}

/** Pure merge (tests, scripts): extra spellings appended once each, the entity's own first. */
export function mergeAliases(entities: readonly TenableEntity[], rows: ReadonlyArray<{ eid: string; aliases: readonly string[] }>): TenableEntity[] {
  const extra = new Map<string, string[]>();
  for (const row of rows) extra.set(row.eid, [...(extra.get(row.eid) ?? []), ...row.aliases]);
  return entities.map((e) => {
    const more = extra.get(e.eid);
    if (!more) return e;
    const seen = new Set([e.name, e.known, ...e.aliases].map((s) => s.toLocaleLowerCase()));
    const added = more.filter((a) => { const k = a.toLocaleLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    return added.length ? { ...e, aliases: [...e.aliases, ...added] } : e;
  });
}
