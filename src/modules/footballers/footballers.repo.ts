import { sql } from '../../db/index.js';
import type { UniversePlayer } from './footballers.universe.js';

export interface ReleaseRow { id: string; fingerprint: string; matcher_version: number; players: number }

const PAGE = 20_000;

export const footballersRepo = {
  async release(id: string): Promise<ReleaseRow | null> {
    const [row] = await sql<ReleaseRow[]>`SELECT id, fingerprint, matcher_version, players FROM wordgame_releases WHERE id = ${id}`;
    return row ?? null;
  },

  /** Every footballer of the release, read in pages by id (plain statements: safe behind the transaction pooler). */
  async players(releaseId: string): Promise<UniversePlayer[]> {
    const players: UniversePlayer[] = [];
    let after = '';
    for (;;) {
      const page = await sql<Array<{ pid: string; name: string; game_name: string; fame: number; aliases: string[] }>>`
        SELECT pid, name, game_name, fame, aliases FROM wordgame_players
        WHERE release_id = ${releaseId} AND pid > ${after} ORDER BY pid LIMIT ${PAGE}
      `;
      for (const row of page) players.push({ pid: row.pid, name: row.name, game: row.game_name, fame: row.fame, aliases: row.aliases });
      if (page.length < PAGE) return players;
      after = page[page.length - 1].pid;
    }
  },
};
