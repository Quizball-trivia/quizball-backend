import { getOrLoadJson } from '../../core/json-cache.js';
import { sql } from '../../db/index.js';

// The alias table only changes with a migration; ten minutes keeps reads off Postgres.
const ALIASES_CACHE_KEY = 'leaderboard:club-aliases:v1';
const ALIASES_CACHE_TTL_SECONDS = 600;
const LOCAL_TTL_MS = 60_000;

let local: { at: number; aliases: Map<string, string>; clubs: Set<string> } | null = null;

async function load() {
  if (local && Date.now() - local.at < LOCAL_TTL_MS) return local;
  const rows = await getOrLoadJson(ALIASES_CACHE_KEY, ALIASES_CACHE_TTL_SECONDS, () =>
    sql<{ alias: string; club_id: string }[]>`SELECT alias, club_id FROM leaderboard_club_aliases`
      .then((result) => result.map((row) => [row.alias, row.club_id] as [string, string])),
  );
  local = { at: Date.now(), aliases: new Map(rows), clubs: new Set(rows.map(([, club]) => club)) };
  return local;
}

/** Canonical club ids for the free-text `users.favorite_club`. */
export const leaderboardClubs = {
  async resolve(favoriteClub: string | null | undefined): Promise<string | null> {
    const alias = favoriteClub?.trim().toLowerCase();
    if (!alias) return null;
    return (await load()).aliases.get(alias) ?? null;
  },

  async exists(clubId: string): Promise<boolean> {
    return (await load()).clubs.has(clubId);
  },

  /** Test hook: forget the in-process copy. */
  resetForTests() {
    local = null;
  },
};
