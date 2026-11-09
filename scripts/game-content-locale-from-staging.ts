/**
 * One locale's game content for PRODUCTION, copied row by row from staging, where translate-game-content.ts,
 * categories-pt.ts and translate-goal-choreographies.ts wrote it and the games' validators checked it: Pistas / Último /
 * Minuto / Buscaminas / Played-for-both / Dato falso / Codenames days, the duel and room pools, store products,
 * categories, Guess-the-Goal cards and Pass Chain players.
 *
 * Rows match on a natural key (day, game + item id, slug, Transfermarkt id), never on a generated id. A production row
 * takes staging's text columns whole only when the two are identical once the locale is set aside: the locale key of
 * every {en,…} node, and the entries the staging fill appended to a list — Pistas' `accepted` (only the normalised forms
 * of the localized display name) and Pass Chain's `aliases` / `normalized_aliases` (only the localized name and its
 * key). A row that differs in anything else or already has the locale somewhere is left alone and counted. Only
 * Guess-the-Goal cards (opt-in, slotFallback) instead fill their empty locale slots where the English is identical,
 * checked by the game's own text rules: their nodes never move, so a slot cannot land on another item.
 *
 *   PROD_DATABASE_URL=… STAGING_DATABASE_URL=… npx tsx scripts/game-content-locale-from-staging.ts --locale=pt [--tables=a,b]          # dry run
 *   PROD_DATABASE_URL=… STAGING_DATABASE_URL=… npx tsx scripts/game-content-locale-from-staging.ts --locale=pt [--tables=a,b] --write
 *
 * Writes: transactions of CHUNK rows (one statement each), a JSON snapshot of the current rows first, and a row is only
 * replaced if it still hashes to what was read.
 */
import postgres from 'postgres';
import { banner, connect, opt, pause, readOnly, requireLocale, sample, snapshot, uniqueBy, WRITE, writeTx } from './locale-copy-common.js';
import { normalizeAnswer } from '../src/modules/pistas/pistas.normalize.js';
import { normalizeAnswerString } from '../src/modules/daily-challenges/answer-normalize.js';
import { indexDay as indexPistasDay } from '../src/modules/pistas/pistas.content.js';
import { indexDay as indexUltimoDay } from '../src/modules/ultimo/ultimo.content.js';
import { indexDay as indexMinutoDay } from '../src/modules/minuto/minuto.content.js';
import { indexDay as indexBuscaminasDay } from '../src/modules/buscaminas/buscaminas.content.js';
import { indexDay as indexSharedPlayerDay } from '../src/modules/shared-player-daily/shared-player-daily.service.js';
import { indexDay as indexDatoFalsoDay } from '../src/modules/dato-falso/dato-falso.service.js';
import { indexDay as indexCodenamesDay } from '../src/modules/codenames/codenames.content.js';
import { pistasRoundSchema } from '../src/modules/duel/engines/pistas.engine.js';
import { buscaminasRoundSchema } from '../src/modules/duel/engines/buscaminas.engine.js';
import { ultimoCategorySchema } from '../src/modules/ultimo/ultimo.match.js';
import { goalSchema } from '../src/modules/minuto/minuto.goal.js';
import { aproximadoItemSchema } from '../src/modules/room/room.types.js';
import { sharedPlayerItemSchema } from '../src/modules/room/games/shared-player/shared-player.engine.js';
import { dfCardSchema } from '../src/modules/room/games/dato-falso/dato-falso.rules.js';
import { codenamesCardSchema } from '../src/modules/room/games/codenames/codenames.rules.js';
import { parseDayFile as parsePistasDay } from '../src/modules/pistas/pistas.seed.js';
import { parseDayFile as parseUltimoDay } from '../src/modules/ultimo/ultimo.seed.js';
import { parseDayFile as parseMinutoDay } from '../src/modules/minuto/minuto.seed.js';
import { parsePoolFile } from '../src/modules/duel/duel.seed.js';
import type { DuelGameId } from '../src/modules/duel/duel.types.js';
import { indexDay as indexConexionesDay } from '../src/modules/conexiones/conexiones.service.js';
import { cxBoardSchema } from '../src/modules/room/games/conexiones/conexiones.rules.js';
import { d501CategorySchema } from '../src/modules/darts501/darts501.content.js';
import { i18nTextSchema as goalText, optionsSchema as goalOptions } from '../src/modules/guess-the-goal/guess-the-goal.schemas.js';
import { z } from 'zod';

/** The text fields of a Guess-the-Goal card, checked by the game's own rules (lengths, option count, one correct). */
const goalTextSchema = z.object({ title: goalText, options: goalOptions, fun_fact: goalText.nullable().optional(), bonus: z.object({ question: goalText, options: goalOptions }).nullable().optional() });

type Row = Record<string, unknown> & { h: string };
type Obj = Record<string, unknown>;
/** A list the comparison found longer on staging: where it sits and what staging appended. */
type Appended = { key: string; parent: Obj | null; added: unknown[] };
interface Spec {
  table: string; key: string[]; columns: string[]; extra?: string[];
  /** Lists (by key, or by column for text[] columns) the staging fill may have appended to. */
  appendable?: ReadonlySet<string>;
  appendedOk?: (appended: Appended[], source: Row) => boolean;
  /** text[] columns (everything else in `columns` is jsonb). */
  lists?: ReadonlySet<string>;
  validate: (row: Row) => boolean;
  /** Fill slot by slot: only this locale's empty slots whose English matches, whatever the row's other locales hold (they differ between environments). */
  slotMerge?: boolean;
  /** Rows the whole-row copy cannot take may fill their empty slots instead (opt-in: only where nodes cannot move). */
  slotFallback?: boolean;
}

const LOCALE = requireLocale();
const CHUNK = 25;
const { prod, staging } = connect();

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isNode = (v: unknown): v is Obj => isObj(v) && typeof v.en === 'string';

/** Whether any {en,…} node under the value carries the locale. */
function hasLocale(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasLocale);
  if (!isObj(v)) return false;
  if (isNode(v) && isText(v[LOCALE])) return true;
  return Object.values(v).some(hasLocale);
}

/**
 * Production value `a` equals staging value `b` once the locale is set aside: the locale key of a text node is ignored,
 * and a list under an appendable key may be longer on staging (the extra entries are collected for the spec to judge).
 */
function sameBesides(a: unknown, b: unknown, appendable: ReadonlySet<string>, appended: Appended[], key = '', parent: Obj | null = null): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (b.length < a.length || (b.length > a.length && !appendable.has(key))) return false;
    if (b.length > a.length) appended.push({ key, parent, added: b.slice(a.length) });
    return a.every((x, i) => sameBesides(x, b[i], appendable, appended, key, parent));
  }
  if (isObj(a) && isObj(b)) {
    const keys = (o: Obj) => Object.keys(o).filter((k) => !(k === LOCALE && isNode(o))).sort();
    const ka = keys(a), kb = keys(b);
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => sameBesides(a[k], b[k], appendable, appended, k, b));
  }
  return a === b;
}

/** The forms translate-game-content.ts adds to Pistas' `accepted` for a localized display name. */
function pistasForms(shown: unknown): Set<string> {
  if (!isText(shown)) return new Set();
  const full = normalizeAnswer(shown);
  const words = full.split(' ').filter(Boolean);
  return new Set([full, ...(words.length >= 2 && words[words.length - 1].length >= 3 ? [words[words.length - 1]] : []), ...(words.length >= 3 ? [words.slice(1).join(' ')] : [])]);
}
const pistasAppendedOk = (appended: Appended[]) => appended.every((a) => {
  const display = isObj(a.parent?.display) ? (a.parent!.display as Obj)[LOCALE] : undefined;
  const forms = pistasForms(display);
  return a.key === 'accepted' && a.added.every((x) => typeof x === 'string' && forms.has(x));
});
const passChainAppendedOk = (appended: Appended[], source: Row) => {
  const name = isObj(source.name) ? source.name[LOCALE] : undefined;
  return appended.length === 0 || isText(name) && appended.every((a) => a.added.length === 1
    && a.added[0] === (a.key === 'aliases' ? name : a.key === 'normalized_aliases' ? normalizeAnswerString(name) : undefined));
};

const accepts = (check: () => unknown): boolean => { try { check(); return true; } catch { return false; } };
const dayRow = (r: Row) => ({ day: r.day as string, number: Number(r.number), contentVersion: Number(r.content_version) });
const seedDay = (r: Row) => ({ day: r.day as string, number: Number(r.number) });
const DAY = ['number', 'content_version'];
const POOL: Record<string, Record<string, { safeParse: (v: unknown) => { success: boolean } }>> = {
  duel_pool: { pistas: pistasRoundSchema, ultimo: ultimoCategorySchema, buscaminas: buscaminasRoundSchema, minuto: goalSchema },
  room_pool: { aproximado: aproximadoItemSchema, shared_player: sharedPlayerItemSchema, dato_falso: dfCardSchema, codenames: codenamesCardSchema, conexiones: cxBoardSchema, darts501: d501CategorySchema },
};
const poolValid = (table: string) => (r: Row) => POOL[table][r.game as string]?.safeParse(r.payload).success ?? false;
const ACCEPTED = new Set(['accepted']);
const always = () => true;
const SPECS: Spec[] = [
  { table: 'pistas_days', key: ['day'], columns: ['rounds'], extra: DAY, appendable: ACCEPTED, appendedOk: pistasAppendedOk, validate: (r) => indexPistasDay({ ...dayRow(r), rounds: r.rounds } as never) !== null && accepts(() => parsePistasDay('stored', { ...seedDay(r), rounds: r.rounds })) },
  { table: 'ultimo_days', key: ['day'], columns: ['categories'], extra: DAY, validate: (r) => indexUltimoDay({ ...dayRow(r), categories: r.categories }) !== null && accepts(() => parseUltimoDay('stored', { ...seedDay(r), categories: r.categories })) },
  { table: 'minuto_days', key: ['day'], columns: ['goals'], extra: DAY, validate: (r) => indexMinutoDay({ ...dayRow(r), goals: r.goals } as never) !== null && accepts(() => parseMinutoDay('stored', { ...seedDay(r), goals: r.goals })) },
  { table: 'buscaminas_days', key: ['day'], columns: ['board'], extra: [...DAY, 'answers'], validate: (r) => indexBuscaminasDay({ ...dayRow(r), board: r.board, answers: r.answers } as never) !== null },
  { table: 'shared_player_days', key: ['day'], columns: ['pairs'], extra: DAY, validate: (r) => indexSharedPlayerDay({ ...dayRow(r), pairs: r.pairs } as never) !== null },
  { table: 'dato_falso_days', key: ['day'], columns: ['cards'], extra: DAY, validate: (r) => indexDatoFalsoDay({ ...dayRow(r), cards: r.cards }) !== null },
  { table: 'codenames_days', key: ['day'], columns: ['board'], extra: DAY, validate: (r) => indexCodenamesDay({ ...dayRow(r), board: r.board }) !== null },
  { table: 'conexiones_days', key: ['day'], columns: ['board'], extra: DAY, validate: (r) => indexConexionesDay({ ...dayRow(r), board: r.board }) !== null },
  { table: 'darts501_days', key: ['day'], columns: ['category'], extra: DAY, validate: (r) => d501CategorySchema.safeParse(r.category).success },
  { table: 'duel_pool', key: ['game', 'item_id'], columns: ['payload'], appendable: ACCEPTED, appendedOk: (a, s) => s.game === 'pistas' ? pistasAppendedOk(a) : a.length === 0, validate: (r) => poolValid('duel_pool')(r) && accepts(() => parsePoolFile(r.game as DuelGameId, { game: r.game, items: [r.payload] })) },
  { table: 'room_pool', key: ['game', 'item_id'], columns: ['payload'], validate: poolValid('room_pool') },
  { table: 'store_products', key: ['slug'], columns: ['name', 'description'], validate: always, slotMerge: true },
  { table: 'categories', key: ['slug'], columns: ['name', 'description'], validate: always, slotMerge: true },
  // Five production goals had their English edited after the copy to staging: their unchanged texts are filled slot by slot.
  { table: 'goal_choreographies', key: ['slug'], columns: ['title', 'options', 'fun_fact', 'bonus'], validate: (r) => goalTextSchema.safeParse(r).success, slotFallback: true },
  { table: 'pass_chain_players', key: ['tm_id'], columns: ['name', 'clubs', 'managers', 'aliases', 'normalized_aliases'], lists: new Set(['aliases', 'normalized_aliases']), appendable: new Set(['aliases', 'normalized_aliases']), appendedOk: passChainAppendedOk, validate: always },
];
const wanted = opt('tables')?.split(',').filter(Boolean) ?? [];
for (const t of wanted) if (!SPECS.some((s) => s.table === t)) { console.error(`ABORT: unknown table ${t}`); process.exit(1); }
const specs = wanted.length ? SPECS.filter((s) => wanted.includes(s.table)) : SPECS;

const keyOf = (spec: Spec, r: Obj) => spec.key.map((k) => String(r[k])).join('|');
const hashExpr = (spec: Spec, alias = '') => `md5(concat_ws('|', ${spec.columns.map((c) => `coalesce(${alias}${c}::text, '∅')`).join(', ')}))`;

async function load(sql: postgres.Sql, spec: Spec): Promise<Row[]> {
  // Keys as text: a date column would otherwise come back as a Date, which the games' day checks refuse.
  const cols = [...spec.key.map((k) => `${k}::text AS ${k}`), ...spec.columns, ...(spec.extra ?? [])];
  return readOnly(sql, (tx) => tx.unsafe<Row[]>(`SELECT ${cols.join(', ')}, ${hashExpr(spec)} AS h FROM ${spec.table} ORDER BY ${spec.key.join(', ')}`));
}

/** Copies this locale's text into `a`'s empty slots where the node sits at the same place in `b` with the same English. Returns how many. */
/** {en,…} nodes with English text and no text in the locale: the independent measure of what is still untranslated. */
function missingSlots(v: unknown): number {
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + missingSlots(x), 0);
  if (!isObj(v)) return 0;
  if (isNode(v)) return isText(v.en) && !isText(v[LOCALE]) ? 1 : 0;
  return Object.values(v).reduce<number>((n, x) => n + missingSlots(x), 0);
}

function mergeSlots(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) return a.reduce<number>((n, x, i) => n + mergeSlots(x, b[i]), 0);
  if (!isObj(a) || !isObj(b)) return 0;
  if (isNode(a) && isNode(b)) {
    if (a.en !== b.en || isText(a[LOCALE]) || !isText(b[LOCALE])) return 0;
    a[LOCALE] = b[LOCALE];
    return 1;
  }
  return Object.keys(a).reduce((n, k) => n + mergeSlots(a[k], b[k]), 0);
}

async function mergeTable(spec: Spec) {
  const [targetRows, sourceRows] = await Promise.all([load(prod, spec), load(staging, spec)]);
  const source = uniqueBy(sourceRows, (r) => keyOf(spec, r));
  const stats = { rows: targetRows.length, noSource: 0, ambiguousKey: 0, slots: 0, toWrite: 0, missingBefore: 0, missingAfter: 0 };
  const plan: Array<{ row: Row; next: Obj }> = [];
  for (const row of targetRows) {
    const src = source.get(keyOf(spec, row));
    if (src === undefined) { stats.noSource += 1; continue; }
    if (src === null) { stats.ambiguousKey += 1; continue; }
    const next = Object.fromEntries(spec.columns.map((c) => [c, structuredClone(row[c])]));
    const filled = spec.columns.reduce((n, c) => n + mergeSlots(next[c], src[c]), 0);
    if (filled === 0) continue;
    stats.slots += filled;
    plan.push({ row, next });
  }
  stats.toWrite = plan.length;
  const planned = new Map(plan.map((p) => [p.row, p.next]));
  for (const row of targetRows) {
    stats.missingBefore += spec.columns.reduce((n, c) => n + missingSlots(row[c]), 0);
    const next = planned.get(row);
    stats.missingAfter += spec.columns.reduce((n, c) => n + missingSlots(next ? next[c] : row[c]), 0);
  }
  console.log(spec.table, stats);
  if (!WRITE || plan.length === 0) return;
  console.log(`  pre-image ${snapshot(`${spec.table}-${LOCALE}-preimage`, plan.map((p) => p.row))}`);
  const recordCols = [...spec.key.map((k) => `${k} text`), ...spec.columns.map((c) => `${c} jsonb`), 'h text'].join(', ');
  const sets = spec.columns.map((c) => `${c} = v.${c}`).join(', ');
  const match = spec.key.map((k) => `t.${k}::text = v.${k}`).join(' AND ');
  let written = 0, skipped = 0, failed = 0;
  for (let c = 0; c < plan.length; c += CHUNK) {
    const chunk = plan.slice(c, c + CHUNK);
    try {
      const done = await writeTx(prod, async (tx) => {
        const records = chunk.map(({ row, next }) => ({ ...Object.fromEntries(spec.key.map((k) => [k, String(row[k])])), ...next, h: row.h }));
        return tx.unsafe(`UPDATE ${spec.table} t SET ${sets} FROM jsonb_to_recordset($1::jsonb) AS v(${recordCols})
          WHERE ${match} AND ${hashExpr(spec, 't.')} = v.h RETURNING 1`, [records] as never[]);
      });
      written += done.length;
      skipped += chunk.length - done.length;
    } catch (e) {
      failed += chunk.length;
      console.error(`  ${spec.table} chunk ${c / CHUNK + 1} rolled back: ${(e as Error).message}`);
    }
    await pause();
  }
  console.log(`  ${spec.table}: written ${written}, skipped (changed meanwhile) ${skipped}, failed ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

async function copyTable(spec: Spec) {
  if (spec.slotMerge) return mergeTable(spec);
  const [targetRows, sourceRows] = await Promise.all([load(prod, spec), load(staging, spec)]);
  const source = uniqueBy(sourceRows, (r) => keyOf(spec, r));
  const keys = { noSource: [] as string[], differs: [] as string[], invalid: [] as string[] };
  const stats = { rows: targetRows.length, alreadyLocale: 0, sourceNoLocale: 0, ambiguousKey: 0, noSource: 0, differs: 0, invalid: 0, slotRows: 0, slots: 0, toWrite: 0, missingBefore: 0, missingAfter: 0 };
  const plan: Array<{ row: Row; next: Obj }> = [];
  for (const row of targetRows) {
    const key = keyOf(spec, row);
    const jsonCols = spec.columns.filter((c) => !spec.lists?.has(c));
    const src = source.get(key);
    // A row the whole-row copy cannot take (partly translated already, or another locale differs) still gets its empty
    // slots, node by node where the English is identical, if the game's own checks accept the result. Tables whose
    // localization also appends to a list (Pistas answers, Pass Chain aliases) need the whole-row path and are left.
    const slotFill = (reason: 'alreadyLocale' | 'differs'): void => {
      if (src && spec.slotFallback && !spec.appendable) {
        const next = Object.fromEntries(spec.columns.map((c) => [c, structuredClone(row[c])]));
        const filled = jsonCols.reduce((n, c) => n + mergeSlots(next[c], src[c]), 0);
        if (filled > 0) {
          if (spec.validate({ ...row, ...next })) { stats.slotRows += 1; stats.slots += filled; plan.push({ row, next }); return; }
          stats.invalid += 1; keys.invalid.push(key); return;
        }
      }
      stats[reason] += 1;
      if (reason === 'differs') keys.differs.push(key);
    };
    if (jsonCols.some((c) => hasLocale(row[c]))) { slotFill('alreadyLocale'); continue; }
    if (src === undefined) { stats.noSource += 1; keys.noSource.push(key); continue; }
    if (src === null) { stats.ambiguousKey += 1; continue; }
    if (!jsonCols.some((c) => hasLocale(src[c]))) { stats.sourceNoLocale += 1; continue; }
    const appended: Appended[] = [];
    const same = spec.columns.every((c) => sameBesides(row[c], src[c], spec.appendable ?? new Set(), appended, c, src));
    if (!same || !(spec.appendedOk ?? ((a: Appended[]) => a.length === 0))(appended, src)) { slotFill('differs'); continue; }
    const next = Object.fromEntries(spec.columns.map((c) => [c, src[c]]));
    if (!spec.validate({ ...row, ...next })) { stats.invalid += 1; keys.invalid.push(key); continue; }
    plan.push({ row, next });
  }
  stats.toWrite = plan.length;
  const jsonColsAll = spec.columns.filter((c) => !spec.lists?.has(c));
  const planned = new Map(plan.map((p) => [p.row, p.next]));
  for (const row of targetRows) {
    stats.missingBefore += jsonColsAll.reduce((n, c) => n + missingSlots(row[c]), 0);
    const next = planned.get(row);
    stats.missingAfter += jsonColsAll.reduce((n, c) => n + missingSlots(next ? next[c] : row[c]), 0);
  }
  console.log(spec.table, stats);
  if (keys.noSource.length) console.log(`  not on staging (translate on production): ${keys.noSource.length}${sample(keys.noSource)}`);
  if (keys.differs.length) console.log(`  differ from staging beyond ${LOCALE} (translate on production): ${keys.differs.length}${sample(keys.differs)}`);
  if (keys.invalid.length) console.log(`  refused by the game's own checks after the copy: ${keys.invalid.length}${sample(keys.invalid)}`);
  if (!WRITE || plan.length === 0) return;

  console.log(`  pre-image ${snapshot(`${spec.table}-${LOCALE}-preimage`, plan.map((p) => p.row))}`);
  let written = 0, skipped = 0, failed = 0;
  const recordCols = [...spec.key.map((k) => `${k} text`), ...spec.columns.map((c) => `${c} ${spec.lists?.has(c) ? 'text[]' : 'jsonb'}`), 'h text'].join(', ');
  const sets = spec.columns.map((c) => `${c} = v.${c}`).join(', ');
  const match = spec.key.map((k) => `t.${k}::text = v.${k}`).join(' AND ');
  for (let c = 0; c < plan.length; c += CHUNK) {
    const chunk = plan.slice(c, c + CHUNK);
    try {
      const done = await writeTx(prod, async (tx) => {
        const records = chunk.map(({ row, next }) => ({ ...Object.fromEntries(spec.key.map((k) => [k, String(row[k])])), ...next, h: row.h }));
        // One statement per chunk; a row is replaced only if it still hashes to what was read.
        return tx.unsafe(`UPDATE ${spec.table} t SET ${sets} FROM jsonb_to_recordset($1::jsonb) AS v(${recordCols})
          WHERE ${match} AND ${hashExpr(spec, 't.')} = v.h RETURNING 1`, [records] as never[]);
      });
      written += done.length;
      skipped += chunk.length - done.length;
    } catch (e) {
      failed += chunk.length;
      console.error(`  ${spec.table} chunk ${c / CHUNK + 1} rolled back: ${(e as Error).message}`);
    }
    await pause();
  }
  console.log(`  ${spec.table}: written ${written}, skipped (changed meanwhile) ${skipped}, failed ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

async function main() {
  // Turkish and French names stay as written, so Pass Chain merges slots and leaves the alias lists alone.
  if (LOCALE === 'tr' || LOCALE === 'fr') for (const spec of specs) if (spec.table === 'pass_chain_players') Object.assign(spec, { columns: ['name', 'clubs', 'managers'], lists: undefined, slotMerge: true });
  banner(`game content · tables ${specs.map((s) => s.table).join(',')}`, LOCALE);
  for (const spec of specs) await copyTable(spec);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => Promise.all([prod.end(), staging.end()]));
