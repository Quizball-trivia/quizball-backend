/**
 * Census + batched delete engine for the seed cleanup (PR11).
 */
import type { SqlLike } from '../persistent-bot-roster/db-types.js';
import {
  deletablePredicate,
  protectedMatchesSql,
  scopeClause,
  selectBatchSql,
  type Scope,
} from './predicate.js';

export interface ScopeCensus {
  scope: Scope;
  /** Rows carrying is_seed in this scope, before any safety clause. */
  total: number;
  /** Rows the predicate would actually delete right now. */
  deletable: number;
  /** total - deletable, i.e. rows the guards deliberately spare. */
  withheld: number;
  /** FK rows the delete must clear by hand (no ON DELETE action). */
  winnerRefs: number;
  lobbyRefs: number;
}

/**
 * Every FK to public.users that has no ON DELETE action, and therefore blocks a
 * delete unless cleared first. Verified against the live schema: of the 48 FKs
 * referencing users, exactly these two are unqualified — all others are
 * ON DELETE CASCADE or ON DELETE SET NULL and need no handling here.
 *
 * `matches.winner_user_id` is NULLed (the historic match survives, winner
 * unknown) rather than deleted; `lobbies` rows are deleted outright, matching
 * what cleanup_ai_users() has always done.
 */
export const BLOCKING_FKS = ['matches.winner_user_id', 'lobbies.host_user_id'] as const;

async function createProtectedTable(tx: SqlLike, recentWindow: number): Promise<void> {
  await tx.unsafe(`DROP TABLE IF EXISTS _seed_protected_match_ids`);
  await tx.unsafe(protectedMatchesSql(recentWindow));
  await tx.unsafe(`CREATE INDEX ON _seed_protected_match_ids (match_id)`);
}

export async function census(
  sql: SqlLike,
  scope: Scope,
  recentWindow: number,
): Promise<ScopeCensus> {
  return sql.begin(async (tx) => {
    await createProtectedTable(tx as unknown as SqlLike, recentWindow);
    const [row] = await tx.unsafe<
      { total: string; deletable: string; winner_refs: string; lobby_refs: string }[]
    >(`
      WITH scoped AS (
        SELECT u.id FROM public.users u
        WHERE u.is_seed = true AND ${scopeClause(scope)}
      ),
      deletable AS (
        SELECT u.id FROM public.users u WHERE ${deletablePredicate(scope)}
      )
      SELECT
        (SELECT count(*) FROM scoped)                                          AS total,
        (SELECT count(*) FROM deletable)                                       AS deletable,
        (SELECT count(*) FROM public.matches m
           WHERE m.winner_user_id IN (SELECT id FROM deletable))               AS winner_refs,
        (SELECT count(*) FROM public.lobbies l
           WHERE l.host_user_id IN (SELECT id FROM deletable))                 AS lobby_refs
    `);
    const total = Number(row?.total ?? 0);
    const deletable = Number(row?.deletable ?? 0);
    return {
      scope,
      total,
      deletable,
      withheld: total - deletable,
      winnerRefs: Number(row?.winner_refs ?? 0),
      lobbyRefs: Number(row?.lobby_refs ?? 0),
    } satisfies ScopeCensus;
  }) as Promise<ScopeCensus>;
}

export interface DeleteProgress {
  batch: number;
  deleted: number;
  runningTotal: number;
}

/**
 * Deletes in bounded batches, each its own transaction, so no single statement
 * holds locks across the whole 21k population and an interrupted run simply
 * resumes (the predicate is stateless — already-deleted rows are just gone).
 */
export async function deleteScope(
  sql: SqlLike,
  scope: Scope,
  opts: {
    batchSize: number;
    recentWindow: number;
    maxBatches?: number;
    /**
     * Optional explicit id allowlist. Purely NARROWING — combined with the full
     * predicate via AND, so it can only ever delete fewer rows, never more.
     */
    restrictToIds?: readonly string[];
  },
  onProgress?: (p: DeleteProgress) => void,
): Promise<number> {
  let runningTotal = 0;
  const restrict = opts.restrictToIds != null;
  for (let batch = 1; opts.maxBatches == null || batch <= opts.maxBatches; batch++) {
    const deleted: number = (await sql.begin(async (tx) => {
      // Rebuilt per transaction: ON COMMIT DROP discards it at each batch
      // boundary, and it must reflect matches settled since the last batch.
      await createProtectedTable(tx as unknown as SqlLike, opts.recentWindow);

      const victims = await tx.unsafe<{ id: string }[]>(
        selectBatchSql(scope, opts.batchSize, restrict),
        restrict ? [opts.restrictToIds as string[]] : [],
      );
      if (victims.length === 0) return 0;
      const ids = victims.map((v) => v.id);

      await tx.unsafe(`UPDATE public.matches SET winner_user_id = NULL WHERE winner_user_id = ANY($1::uuid[])`, [ids]);
      await tx.unsafe(`DELETE FROM public.lobbies WHERE host_user_id = ANY($1::uuid[])`, [ids]);
      const res = await tx.unsafe(`DELETE FROM public.users WHERE id = ANY($1::uuid[])`, [ids]);
      return res.count ?? 0;
    })) as number;

    if (deleted === 0) break;
    runningTotal += deleted;
    onProgress?.({ batch, deleted, runningTotal });
  }
  return runningTotal;
}

/**
 * Drains aged ephemeral/auction AI by calling the existing cleanup_ai_users(),
 * rather than reimplementing its guards. That function already encodes the
 * 10-match visibility window, friendship/pending-request protection, the
 * mid-match guard and — since 20260727150000 — the
 * `ai_kind IN ('ephemeral','auction')` allowlist that makes persistent roster
 * bots structurally unreachable. Duplicating those rules in TypeScript would
 * mean two definitions of "safe to delete" that can drift.
 *
 * It is SECURITY DEFINER with statement_timeout = 0 and loops internally until
 * it finds no more victims, so a single call drains fully; it is invoked once
 * and its return value reported.
 */
export async function drainEphemeral(sql: SqlLike): Promise<number> {
  const [row] = await sql.unsafe<{ cleanup_ai_users: number }[]>(`SELECT cleanup_ai_users()`);
  return Number(row?.cleanup_ai_users ?? 0);
}
