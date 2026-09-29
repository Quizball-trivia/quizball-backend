import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { normalizeAnswer, samePlayer } from '../pistas/pistas.normalize.js';
import { buscaminasRoundSchema } from './engines/buscaminas.engine.js';
import { pistasRoundSchema } from './engines/pistas.engine.js';
import type { DuelGameId } from './duel.types.js';

export interface PoolRow {
  itemId: string;
  difficulty: 'easy' | 'medium' | 'hard';
  fingerprint: string;
  payload: unknown;
  /** Buscaminas: the normalised category prompt, for the overlap check. */
  keys: string[];
  /** Pistas: who the player is (display names + accepted answers), for the overlap check. */
  player?: { display: string[]; accepted: string[] };
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** Validates one private pool file ({game, items: [...]}); throws with the item index only, never its text. */
export function parsePoolFile(game: DuelGameId, raw: unknown): PoolRow[] {
  const file = raw as { game?: unknown; items?: unknown };
  if (file?.game !== game) throw new Error(`pool file game must be "${game}"`);
  if (!Array.isArray(file.items) || file.items.length === 0) throw new Error('pool file needs a non-empty items array');
  const seen = new Set<string>();
  return file.items.map((item, i) => {
    const row = game === 'pistas' ? pistasRow(item) : buscaminasRow(item);
    if (!row) throw new Error(`item ${i} is not a valid ${game} pool item`);
    if (seen.has(row.itemId)) throw new Error(`item ${i}: duplicate id`);
    seen.add(row.itemId);
    return row;
  });
}

function pistasRow(item: unknown): PoolRow | null {
  const parsed = pistasRoundSchema.safeParse(item);
  if (!parsed.success) return null;
  const round = parsed.data;
  const names = new Set([...round.answer.accepted, ...Object.values(round.answer.display).map(normalizeAnswer)]);
  // Every display name must be typeable, and no clue may give the answer away.
  if (Object.values(round.answer.display).some((name) => !round.answer.accepted.includes(normalizeAnswer(name)))) return null;
  for (const clue of round.clues) {
    for (const text of Object.values(clue.text)) {
      const words = ` ${normalizeAnswer(text)} `;
      if ([...names].some((name) => name.length > 2 && words.includes(` ${name} `))) return null;
    }
  }
  return {
    itemId: round.id, difficulty: round.difficulty, fingerprint: sha(normalizeAnswer(round.answer.display.en)), payload: round, keys: [],
    player: { display: Object.values(round.answer.display), accepted: round.answer.accepted },
  };
}

function buscaminasRow(item: unknown): PoolRow | null {
  const parsed = buscaminasRoundSchema.safeParse(item);
  if (!parsed.success) return null;
  const round = parsed.data;
  const prompt = normalizeAnswer(round.prompt.es);
  const cards = round.cards.map((c) => c.id).sort().join(',');
  return { itemId: round.id, difficulty: round.difficulty, fingerprint: sha(`${prompt}|${cards}`), payload: round, keys: [prompt] };
}

export interface OverlapReport {
  /** Pool items (by index) that share a player / a category with a scheduled daily. */
  overlapping: number[];
}

/**
 * Duel content must never teach a daily: a Pistas pool player may not be any daily's answer, a Buscaminas pool
 * category may not be any daily round's category. Checked against every stored day, past and future.
 */
export async function findDailyOverlap(sql: Sql, game: DuelGameId, rows: PoolRow[]): Promise<OverlapReport> {
  const daily = new Set<string>();
  if (game === 'pistas') {
    const days = await sql<Array<{ rounds: Array<{ answer: { display: Record<string, string>; accepted: string[] } }> }>>`SELECT rounds FROM pistas_days`;
    const players = days.flatMap((day) => day.rounds.map((round) => ({ display: Object.values(round.answer.display), accepted: round.answer.accepted })));
    const overlapping = rows.flatMap((row, i) => (row.player && players.some((player) => samePlayer(row.player!, player)) ? [i] : []));
    return { overlapping };
  } else {
    const days = await sql<Array<{ board: { rounds: Array<{ prompt: Record<string, string> }> } }>>`SELECT board FROM buscaminas_days`;
    for (const day of days) for (const round of day.board.rounds) daily.add(normalizeAnswer(round.prompt.es));
  }
  const overlapping = rows.flatMap((row, i) => (row.keys.some((key) => key.length > 2 && daily.has(key)) ? [i] : []));
  return { overlapping };
}

export async function writePool(sql: Sql, game: DuelGameId, rows: PoolRow[]): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  await sql.begin(async (tx) => {
    const q = tx as unknown as Sql;
    await q`SET LOCAL lock_timeout = '5s'`;
    await q`SET LOCAL statement_timeout = '60s'`;
    await q`SET LOCAL idle_in_transaction_session_timeout = '60s'`;
    for (const row of rows) {
      const [result] = await q<Array<{ inserted: boolean }>>`
        INSERT INTO duel_pool (game, item_id, difficulty, fingerprint, payload, enabled)
        VALUES (${game}, ${row.itemId}, ${row.difficulty}, ${row.fingerprint}, ${q.json(row.payload as never)}, true)
        ON CONFLICT (game, item_id) DO UPDATE SET difficulty = EXCLUDED.difficulty, fingerprint = EXCLUDED.fingerprint,
          payload = EXCLUDED.payload, enabled = true, updated_at = now()
        RETURNING (xmax = 0) AS inserted
      `;
      if (result.inserted) inserted += 1;
      else updated += 1;
    }
  });
  return { inserted, updated };
}
