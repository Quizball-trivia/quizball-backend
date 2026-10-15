import { createHmac } from 'node:crypto';
import { config } from '../../core/config.js';
import { InternalError } from '../../core/errors.js';
import { sql } from '../../db/index.js';

export const FOOTBALL_GRID_OPTION_COUNT = 4;
/** The right option is drawn from this many of the cell's best-known unused answers. */
const CORRECT_POOL_SIZE = 6;
/** Wrong options are drawn from this many of the best-known footballers that share one of the two categories. */
const DISTRACTOR_POOL_SIZE = 12;
const BOARD_PLAYERS_CACHE_TTL_MS = 10 * 60_000;
const BOARD_PLAYERS_CACHE_MAX_ENTRIES = 256;

export interface FootballGridBoardPlayer {
  cellIndex: number;
  playerId: string;
  name: string;
  nameKa: string | null;
  nameRu: string | null;
  imageUrl: string | null;
}

export interface FootballGridOption {
  playerId: string;
  name: string;
  nameKa: string | null;
  nameRu: string | null;
  imageUrl: string | null;
}

/** Every answer of a board, best-known first within each cell. */
export type FootballGridBoardPlayers = ReadonlyMap<number, readonly FootballGridBoardPlayer[]>;

const boardPlayersCache = new Map<string, { expiresAt: number; value: Promise<FootballGridBoardPlayers> }>();

async function loadBoardPlayers(boardId: string): Promise<FootballGridBoardPlayers> {
  const rows = await sql<Array<{
    cell_index: number; football_player_id: string; name: string; name_ka: string | null; name_ru: string | null; image_url: string | null;
  }>>`
    SELECT a.cell_index, a.football_player_id,
           COALESCE(NULLIF(fp.name, ''), a.player_name_en) AS name,
           a.player_name_ka AS name_ka,
           (SELECT al.alias FROM football_grid_player_aliases al
               WHERE al.release_id = b.release_id AND al.football_player_id = a.football_player_id
                 AND al.locale = 'ru' AND al.alias_type = 'transliteration' AND al.acceptance_policy = 'exact'
               ORDER BY al.reviewed_at DESC, al.alias LIMIT 1) AS name_ru,
           fp.image_url
      FROM football_grid_board_answers a
      JOIN football_grid_boards b ON b.id = a.board_id
      JOIN football_players fp ON fp.id = a.football_player_id
     WHERE a.board_id = ${boardId}
     ORDER BY a.cell_index, a.is_sample DESC, a.recognizable_rank ASC NULLS LAST,
              fp.fame_score DESC NULLS LAST, a.football_player_id
  `;
  const byCell = new Map<number, FootballGridBoardPlayer[]>();
  for (const row of rows) {
    const cell = byCell.get(row.cell_index) ?? [];
    cell.push({
      cellIndex: row.cell_index,
      playerId: row.football_player_id,
      name: row.name,
      nameKa: row.name_ka,
      nameRu: row.name_ru,
      imageUrl: row.image_url,
    });
    byCell.set(row.cell_index, cell);
  }
  return byCell;
}

/** Board answers never change once published, so a short in-process cache is safe. */
export async function getFootballGridBoardPlayers(boardId: string): Promise<FootballGridBoardPlayers> {
  const now = Date.now();
  const cached = boardPlayersCache.get(boardId);
  if (cached && cached.expiresAt > now) return cached.value;
  const entry = { expiresAt: now + BOARD_PLAYERS_CACHE_TTL_MS, value: loadBoardPlayers(boardId) };
  boardPlayersCache.set(boardId, entry);
  while (boardPlayersCache.size > BOARD_PLAYERS_CACHE_MAX_ENTRIES) {
    const oldest = boardPlayersCache.keys().next().value as string | undefined;
    if (!oldest) break;
    boardPlayersCache.delete(oldest);
  }
  try {
    return await entry.value;
  } catch (error) {
    if (boardPlayersCache.get(boardId) === entry) boardPlayersCache.delete(boardId);
    throw error;
  }
}

/** The server secret behind option order and same-phone tickets: nothing a client knows may predict either. */
export function footballGridSecret(): string {
  const secret = config.FOOTBALL_GRID_RISK_HASH_SECRET?.trim() || config.SUPABASE_JWT_SECRET;
  if (!secret) throw new InternalError('No secret is configured for Football Grid');
  return secret;
}

function seededRandom(seed: string, secret: string): () => number {
  // Keyed: match id, turn and cell are known to the client, so a plain hash of them would give the order away.
  let state = createHmac('sha256', secret).update(`football-grid-options:${seed}`).digest().readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function nameKey(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/**
 * Four footballers for a cell: one of its best-known unused answers and three who fit one of its two categories
 * but not both. The same seed always gives the same four, so a player cannot re-roll them by asking again.
 * Null when the cell has no unused answer left or the board cannot fill four distinct names.
 */
export function buildFootballGridOptions(input: {
  players: FootballGridBoardPlayers;
  cellIndex: number;
  usedPlayerIds: ReadonlySet<string>;
  seed: string;
  /** Defaults to the server secret; tests pass their own. */
  secret?: string;
}): FootballGridOption[] | null {
  const random = seededRandom(input.seed, input.secret ?? footballGridSecret());
  const cell = input.players.get(input.cellIndex) ?? [];
  const validIds = new Set(cell.map((player) => player.playerId));
  const correctPool = cell.filter((player) => !input.usedPlayerIds.has(player.playerId)).slice(0, CORRECT_POOL_SIZE);
  if (correctPool.length === 0) return null;
  const correct = correctPool[Math.floor(random() * correctPool.length)];

  const row = Math.floor(input.cellIndex / 3);
  const column = input.cellIndex % 3;
  const sharesCategory = (cellIndex: number): boolean =>
    cellIndex !== input.cellIndex && (Math.floor(cellIndex / 3) === row || cellIndex % 3 === column);
  // Two options never share a label in either script: a player must be able to tell the four apart.
  const labels = (player: FootballGridBoardPlayer): string[] => [nameKey(player.name), ...(player.nameKa ? [nameKey(player.nameKa)] : []), ...(player.nameRu ? [nameKey(player.nameRu)] : [])];
  const takenNames = new Set(labels(correct));
  const takenIds = new Set([correct.playerId]);
  const collect = (cells: number[]): FootballGridBoardPlayer[] => {
    // Interleave the cells so the wrong options do not all come from one neighbour.
    const queues = cells.map((cellIndex) => (input.players.get(cellIndex) ?? []).filter((player) =>
      !validIds.has(player.playerId) && !input.usedPlayerIds.has(player.playerId)));
    const pool: FootballGridBoardPlayer[] = [];
    for (let depth = 0; pool.length < DISTRACTOR_POOL_SIZE && queues.some((queue) => depth < queue.length); depth += 1) {
      for (const queue of queues) {
        const player = queue[depth];
        if (!player || takenIds.has(player.playerId) || labels(player).some((label) => takenNames.has(label))) continue;
        takenIds.add(player.playerId);
        for (const label of labels(player)) takenNames.add(label);
        pool.push(player);
      }
    }
    return pool;
  };
  const allCells = Array.from({ length: 9 }, (_, cellIndex) => cellIndex);
  const pool = collect(allCells.filter(sharesCategory));
  if (pool.length < FOOTBALL_GRID_OPTION_COUNT - 1) {
    pool.push(...collect(allCells.filter((cellIndex) => cellIndex !== input.cellIndex && !sharesCategory(cellIndex))));
  }
  if (pool.length < FOOTBALL_GRID_OPTION_COUNT - 1) return null;
  const distractors: FootballGridBoardPlayer[] = [];
  while (distractors.length < FOOTBALL_GRID_OPTION_COUNT - 1) {
    distractors.push(...pool.splice(Math.floor(random() * pool.length), 1));
  }
  const options = [correct, ...distractors];
  for (let index = options.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [options[index], options[swap]] = [options[swap], options[index]];
  }
  return options.map((player) => ({
    playerId: player.playerId,
    name: player.name,
    nameKa: player.nameKa,
    nameRu: player.nameRu,
    imageUrl: player.imageUrl,
  }));
}

export function footballGridMatchOptionSeed(matchId: string, turnNumber: number, cellIndex: number): string {
  return `${matchId}:${turnNumber}:${cellIndex}`;
}
