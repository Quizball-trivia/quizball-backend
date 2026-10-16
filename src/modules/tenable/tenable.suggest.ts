import { AppError } from '../../core/errors.js';
import { sql } from '../../db/index.js';
import { tenableDailyContent } from '../tenable-daily/tenable-daily.service.js';
import { tenableDirectories } from './tenable.directories.js';
import { ENTITY_KINDS, SUGGEST_LIMIT, type EntityKind, type Suggestion } from './tenable.identify.js';

const ALLOWED_REFRESH_MS = 60_000;
/** A pair not in the set re-reads it at most this often (a list seeded or dealt a moment ago). */
const MISS_REFRESH_MS = 5_000;
let allowed: { at: number; keys: Set<string> } | null = null;

/**
 * The (kind, release) pairs some served day, enabled room list or live match uses: suggestions are served for these
 * only, so a caller can never make a replica load a release nothing plays on. A live match keeps its releases after
 * its lists leave the pool.
 */
async function allowedPairs(key: string): Promise<Set<string>> {
  const age = allowed ? Date.now() - allowed.at : Infinity;
  if (allowed && (age < MISS_REFRESH_MS || (age < ALLOWED_REFRESH_MS && allowed.keys.has(key)))) return allowed.keys;
  const keys = new Set<string>();
  for (const day of (await tenableDailyContent.get()).values()) keys.add(`${day.list.kind}:${day.list.release}`);
  const rooms = await sql<Array<{ kind: string; release: string }>>`
    SELECT DISTINCT payload->>'kind' AS kind, payload->>'release' AS release FROM room_pool WHERE game = 'tenable' AND enabled
    UNION
    SELECT DISTINCT l->>'kind', l->>'release'
    FROM room_matches m JOIN room_match_content c ON c.match_id = m.id CROSS JOIN jsonb_array_elements(c.content->'lists') l
    WHERE m.game = 'tenable' AND m.status IN ('ready', 'active')`;
  for (const row of rooms) keys.add(`${row.kind}:${row.release}`);
  allowed = { at: Date.now(), keys };
  return keys;
}

/**
 * Names that start with what was typed, best known first, from the whole release of that kind: the same answer whatever
 * any list holds. Unknown pairs get an empty list (never an error that would say which releases exist); a release that
 * cannot be loaded right now is a 503, never an empty answer someone would cache.
 */
export async function suggest(kind: string, release: string, query: string): Promise<Suggestion[]> {
  if (!(ENTITY_KINDS as readonly string[]).includes(kind)) return [];
  const key = `${kind}:${release}`;
  if (!tenableDirectories.loaded(kind as EntityKind, release) && !(await allowedPairs(key)).has(key)) return [];
  const directory = await tenableDirectories.get(kind as EntityKind, release).catch(() => null);
  if (!directory) throw new AppError('Suggestions are unavailable right now', 503);
  return directory.suggest(query, SUGGEST_LIMIT);
}
