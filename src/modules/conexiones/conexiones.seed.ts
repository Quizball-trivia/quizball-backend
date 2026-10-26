import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type postgres from 'postgres';
import type { CxBoard } from '../room/games/conexiones/conexiones.rules.js';

/**
 * What both Conexiones seeders (days and room pool) check, under the same advisory lock: every board approved by the
 * fact-check exactly as it is, and nothing one side shows giving away a group of the other.
 */

/** A footballer's name as the overlap check compares it (one person can come from two sources under two ids). */
const UNDECOMPOSED: Record<string, string> = { ø: 'o', ł: 'l', đ: 'd', ð: 'd', ß: 'ss', æ: 'ae', œ: 'oe', ı: 'i', þ: 'th', ħ: 'h' };
/** NFKD leaves these letters whole, so "Ødegaard" would fold to "degaard" and miss "Odegaard". */
export const foldName = (name: string) => name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[øłđðßæœıþħ]/g, (ch) => UNDECOMPOSED[ch]).replace(/[^a-z0-9]+/g, ' ').trim();

/** The hash the fact-check approved a board under: of the board exactly as seeded. */
export const boardHash = (board: CxBoard) => createHash('sha256').update(JSON.stringify(board)).digest('hex');

const approvalsSchema = z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/));

/** Refuses any board whose content is not the one the fact-check approved (a hand edit after the check, or no check). */
export function requireApproved(boards: readonly CxBoard[], approvedFile: string | undefined): void {
  if (!approvedFile) throw new Error('--approved <approved.json> is required (the fact-check approval of each board)');
  const approved = approvalsSchema.parse(JSON.parse(readFileSync(resolve(approvedFile), 'utf8')));
  const bad = boards.filter((b) => approved[b.id] !== boardHash(b));
  if (bad.length > 0) throw new Error(`${bad.length} board(s) are not approved as they are (first ${bad[0].id})`);
}

/** A seeder's transaction (its own connection, not the app pool). */
type Tx = postgres.TransactionSql<Record<string, unknown>> | postgres.Sql;
const q = (tx: Tx) => tx as postgres.Sql;

export type CxSide = 'daily' | 'room';
export interface LedgerRow { board_id: string; group_id: string; link_key: string; player_id: string; player_name: string }

export const ledgerRows = (board: CxBoard): LedgerRow[] => board.groups.flatMap((g) => g.members.map((tile) => {
  const t = board.tiles.find((x) => x.id === tile)!;
  return { board_id: board.id, group_id: g.id, link_key: g.key, player_id: t.player, player_name: foldName(t.name.en) };
}));

/** Shared footballers between two groups, by id or by name. */
function shared(a: readonly LedgerRow[], b: readonly LedgerRow[]): number {
  return a.filter((x) => b.some((y) => y.player_id === x.player_id || y.player_name === x.player_name)).length;
}

/**
 * Throws when a group of these boards is too close to what the other side ever showed (corrected or retired ones too):
 * three of its footballers together in one group under any link, or two of them under the same link anywhere on the
 * other side (one group or several: four boards each showing one member under the daily's link reveal it as well).
 */
export async function refuseOverlap(t: Tx, side: CxSide, boards: readonly CxBoard[]): Promise<void> {
  const tx = q(t);
  const rows = boards.flatMap(ledgerRows);
  const other = await tx<LedgerRow[]>`
    SELECT board_id, group_id, link_key, player_id, player_name FROM conexiones_ledger
    WHERE side = ${side === 'daily' ? 'room' : 'daily'}
      AND (player_id = ANY(${tx.array(rows.map((r) => r.player_id))}::text[]) OR player_name = ANY(${tx.array(rows.map((r) => r.player_name))}::text[]))`;
  const byGroup = (list: readonly LedgerRow[]) => {
    const map = new Map<string, LedgerRow[]>();
    for (const r of list) map.set(`${r.board_id}|${r.group_id}`, [...(map.get(`${r.board_id}|${r.group_id}`) ?? []), r]);
    return map;
  };
  // The other side's groups in full (the query above returned only their rows of these footballers).
  const otherKeys = [...new Set(other.map((r) => `${r.board_id}|${r.group_id}`))];
  const full = otherKeys.length === 0 ? [] : await tx<LedgerRow[]>`
    SELECT board_id, group_id, link_key, player_id, player_name FROM conexiones_ledger
    WHERE side = ${side === 'daily' ? 'room' : 'daily'} AND (board_id || '|' || group_id) = ANY(${tx.array(otherKeys)}::text[])`;
  const theirs = byGroup(full);
  const otherSide = side === 'daily' ? 'room' : 'daily';
  for (const [key, mine] of byGroup(rows)) {
    for (const [otherKey, group] of theirs) {
      const n = shared(mine, group);
      if (n >= 3) throw new Error(`Group ${key} shares ${n} footballers with ${otherSide} group ${otherKey}; refused`);
    }
  }
  // Under one link, the other side's group may share at most one footballer with everything this side ever showed under
  // it (stored and incoming together): four boards each showing one member would give the group away.
  const links = [...new Set(rows.map((r) => r.link_key))];
  const ours = [...rows, ...await tx<LedgerRow[]>`
    SELECT board_id, group_id, link_key, player_id, player_name FROM conexiones_ledger
    WHERE side = ${side} AND link_key = ANY(${tx.array(links)}::text[])`];
  const theirsByLink = await tx<LedgerRow[]>`
    SELECT board_id, group_id, link_key, player_id, player_name FROM conexiones_ledger
    WHERE side = ${otherSide} AND link_key = ANY(${tx.array(links)}::text[])`;
  for (const [otherKey, group] of byGroup(theirsByLink)) {
    const n = shared(group, ours.filter((r) => r.link_key === group[0].link_key));
    if (n >= 2) throw new Error(`${otherSide} group ${otherKey} would have ${n} footballers shown under the same link (${group[0].link_key}) on this side; refused`);
  }
  // And the other way round: an incoming group against everything the other side ever showed under its link.
  for (const [key, mine] of byGroup(rows)) {
    const n = shared(mine, theirsByLink.filter((r) => r.link_key === mine[0].link_key));
    if (n >= 2) throw new Error(`Group ${key} has ${n} footballers already shown under the same link (${mine[0].link_key}) on the ${otherSide} side; refused`);
  }
}

export async function writeLedger(t: Tx, side: CxSide, boards: ReadonlyArray<{ board: CxBoard; day?: string }>): Promise<void> {
  const tx = q(t);
  const rows = boards.flatMap(({ board, day }) => ledgerRows(board).map((r) => ({ ...r, day: day ?? null })));
  if (rows.length === 0) return;
  await tx`
    INSERT INTO conexiones_ledger (side, board_id, group_id, link_key, player_id, player_name, day)
    SELECT ${side}, * FROM unnest(
      ${tx.array(rows.map((r) => r.board_id))}::text[], ${tx.array(rows.map((r) => r.group_id))}::text[], ${tx.array(rows.map((r) => r.link_key))}::text[],
      ${tx.array(rows.map((r) => r.player_id))}::text[], ${tx.array(rows.map((r) => r.player_name))}::text[], ${tx.array(rows.map((r) => r.day) as string[])}::date[])
    ON CONFLICT DO NOTHING`;
}
