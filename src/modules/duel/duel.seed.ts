import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { normalizeAnswer } from '../pistas/pistas.normalize.js';
import { buscaminasRoundSchema } from './engines/buscaminas.engine.js';
import { pistasRoundSchema } from './engines/pistas.engine.js';
import { canonical, ledgerDailyPlayers, PISTAS_CONTENT_LOCK, recordPistasContent } from '../pistas/pistas.seed.js';
import { BUSCAMINAS_CONTENT_LOCK, dailyKeys as buscaminasDailyKeys, recordBuscaminasContent } from '../buscaminas/buscaminas.seed.js';
import { ultimoCategorySchema, unreachableAnswers, type UltimoCategory } from '../ultimo/ultimo.match.js';
import { keysOf, publishedKeys, recordPublished, sameKeys, ULTIMO_CONTENT_LOCK } from '../ultimo/ultimo.seed.js';
import type { DuelGameId } from './duel.types.js';
import type { MinutoGoal } from '../minuto/minuto.goal.js';
import { checkGoal, MINUTO_CONTENT_LOCK, overlapping as minutoOverlapping, publishedKeys as minutoPublishedKeys, recordPublished as recordMinutoPublished } from '../minuto/minuto.seed.js';

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
    const row = game === 'pistas' ? pistasRow(item) : game === 'ultimo' ? ultimoRow(item) : game === 'minuto' ? minutoRow(item) : buscaminasRow(item);
    if (!row) throw new Error(`item ${i} is not a valid ${game} pool item`);
    if (seen.has(row.itemId)) throw new Error(`item ${i}: duplicate id`);
    if (game === 'minuto' && seen.has(`fp:${row.fingerprint}`)) throw new Error(`item ${i}: duplicate goal (fingerprint)`);
    seen.add(row.itemId);
    if (game === 'minuto') seen.add(`fp:${row.fingerprint}`);
    return row;
  });
}

const displayOf = (payload: unknown): Record<string, string> => (payload as { answer: { display: Record<string, string> } }).answer.display;

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

function ultimoRow(item: unknown): PoolRow | null {
  const parsed = ultimoCategorySchema.safeParse(item);
  if (!parsed.success) return null;
  const category = parsed.data;
  if (unreachableAnswers(category).length > 0) return null;
  return { itemId: category.id, difficulty: category.difficulty, fingerprint: sha(canonical(category)), payload: category, keys: [] };
}

/** Pool items (by index) repeating any daily category ever published (same id, title or most of the answers). */
async function ultimoDailyOverlap(sql: Sql, rows: PoolRow[]): Promise<number[]> {
  const daily = await publishedKeys(sql, 'day');
  return rows.flatMap((row, i) => (daily.some((keys) => sameKeys(keysOf(row.payload as UltimoCategory), keys)) ? [i] : []));
}

function minutoRow(item: unknown): PoolRow | null {
  const checked = checkGoal(item);
  if ('reason' in checked) return null;
  const goal = checked.goal;
  return { itemId: goal.id, difficulty: goal.tier, fingerprint: goal.fingerprint, payload: goal, keys: [] };
}

/** Pool goals (by index) published on any daily day, now or ever (by id or by fingerprint). */
async function minutoDailyOverlap(sql: Sql, rows: PoolRow[]): Promise<number[]> {
  return minutoOverlapping(rows.map((row) => row.payload as MinutoGoal), await minutoPublishedKeys(sql, 'day'));
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
  if (game === 'ultimo') return { overlapping: await ultimoDailyOverlap(sql, rows) };
  if (game === 'minuto') return { overlapping: await minutoDailyOverlap(sql, rows) };
  if (game === 'pistas') {
    // the stored days plus every player a day ever published (the ledger keeps the ones corrected away)
    const days = [...await sql<Array<{ rounds: Array<{ answer: { display: Record<string, string>; accepted: string[] } }> }>>`SELECT rounds FROM pistas_days`, ...await ledgerDailyPlayers(sql)];
    // samePlayer against every daily player, indexed: a display name of one side among all names of the other
    const names = (values: Iterable<string>) => [...values].map(normalizeAnswer).filter((v) => v.length > 2);
    const dailyDisplay = new Set<string>();
    const dailyAny = new Set<string>();
    for (const day of days) {
      for (const round of day.rounds) {
        const display = Object.values(round.answer.display);
        for (const name of names(display)) dailyDisplay.add(name);
        for (const name of names([...display, ...round.answer.accepted])) dailyAny.add(name);
      }
    }
    const overlapping = rows.flatMap((row, i) => {
      if (!row.player) return [];
      const hit = names(row.player.display).some((name) => dailyAny.has(name))
        || names([...row.player.display, ...row.player.accepted]).some((name) => dailyDisplay.has(name));
      return hit ? [i] : [];
    });
    return { overlapping };
  } else {
    for (const key of await buscaminasDailyKeys(sql)) daily.add(key);
  }
  const overlapping = rows.flatMap((row, i) => (row.keys.some((key) => key.length > 2 && daily.has(key)) ? [i] : []));
  return { overlapping };
}

export async function writePool(sql: Sql, game: DuelGameId, rows: PoolRow[], opts: { allowOverlap?: boolean } = {}): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  await sql.begin(async (tx) => {
    const q = tx as unknown as Sql;
    await q`SET LOCAL lock_timeout = '5s'`;
    await q`SET LOCAL statement_timeout = '60s'`;
    await q`SET LOCAL idle_in_transaction_session_timeout = '60s'`;
    if (game === 'pistas' || game === 'buscaminas') {
      // The days seed takes the same lock and checks the pool inside its write; this re-checks the days inside this one.
      await q`SELECT pg_advisory_xact_lock(hashtext(${game === 'pistas' ? PISTAS_CONTENT_LOCK : BUSCAMINAS_CONTENT_LOCK}))`;
      const { overlapping } = await findDailyOverlap(q, game, rows);
      if (overlapping.length > 0 && !opts.allowOverlap) throw new Error(`${overlapping.length} pool item(s) share a player or category with a daily; refused`);
    }
    if (game === 'ultimo') {
      // The days seed takes the same lock: the overlap is re-checked here, inside the write, so neither seed can
      // slip in a category the other is writing at the same moment.
      await q`SELECT pg_advisory_xact_lock(hashtext(${ULTIMO_CONTENT_LOCK}))`;
      const overlap = await ultimoDailyOverlap(q, rows);
      if (overlap.length > 0 && !opts.allowOverlap) throw new Error(`${overlap.length} pool item(s) repeat a daily category; refused`);
    }
    if (game === 'minuto') {
      // Same rule for the goals: the days seed takes this lock too, and the overlap is re-checked inside the write.
      await q`SELECT pg_advisory_xact_lock(hashtext(${MINUTO_CONTENT_LOCK}))`;
      const overlap = await minutoDailyOverlap(q, rows);
      if (overlap.length > 0 && !opts.allowOverlap) throw new Error(`${overlap.length} pool goal(s) are on a daily day; refused`);
      // One pool row per goal: the same goal under another id could be dealt twice and answer itself.
      const stored = await q<Array<{ item_id: string; fingerprint: string }>>`SELECT item_id, fingerprint FROM duel_pool WHERE game = 'minuto'`;
      const twins = rows.filter((row) => stored.some((s) => s.fingerprint === row.fingerprint && s.item_id !== row.itemId));
      if (twins.length > 0) throw new Error(`${twins.length} pool goal(s) are already in the pool under another id; refused`);
    }
    // what the pool holds before this write (content dealt before the ledger existed, and items this write replaces),
    // read as stored: an item that would no longer parse is still remembered
    const beforeWrite = game === 'buscaminas' || game === 'pistas'
      ? await q<Array<{ prompt: string | null; display: Record<string, string> | null; accepted: string[] | null }>>`
        SELECT payload->'prompt'->>'es' AS prompt, payload->'answer'->'display' AS display, payload->'answer'->'accepted' AS accepted
        FROM duel_pool WHERE game = ${game}`
      : [];
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
    if (game === 'ultimo') await recordPublished(q, 'pool', rows.map((row) => row.payload as UltimoCategory));
    if (game === 'buscaminas') {
      await recordBuscaminasContent(q, 'pool', [
        ...beforeWrite.flatMap((r) => (r.prompt ? [{ key: normalizeAnswer(r.prompt), day: null }] : [])),
        ...rows.flatMap((row) => row.keys.map((key) => ({ key, day: null }))),
      ]);
    }
    if (game === 'pistas') {
      await recordPistasContent(q, 'pool', [
        ...beforeWrite.flatMap((r) => (r.display ? [{ display: r.display, accepted: r.accepted ?? [], day: null }] : [])),
        ...rows.flatMap((row) => (row.player ? [{ display: displayOf(row.payload), accepted: [...row.player.accepted], day: null }] : [])),
      ]);
    }
    if (game === 'minuto') await recordMinutoPublished(q, 'pool', rows.map((row) => row.payload as MinutoGoal));
  });
  return { inserted, updated };
}
