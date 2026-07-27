/**
 * Roster ROLLBACK script — deletes exactly one generation batch.
 *
 * Selects roster users by synthetic_player_profiles.schedule->>'batch' = <tag>,
 * asserts every selected user is a persistent bot with no auth identity (a
 * safety refusal — this must never touch a real user), then deletes the users.
 * synthetic_player_profiles, synthetic_bot_reservations and ranked_profiles all
 * cascade via ON DELETE CASCADE, so deleting the users row cleans up everything.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/persistent-bot-roster/rollback.ts \
 *     --batch roster-2026-07-27 [--dry]
 */

import postgres from 'postgres';

import type { SqlLike, Tx } from './db-types.js';

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export interface RollbackResult {
  batch: string;
  candidates: number;
  deleted: number;
  refusedReason?: string;
}

/** Exported for the integration test. Runs the whole rollback in one tx. */
export async function rollbackBatch(
  sql: SqlLike,
  batch: string,
  opts: { dry?: boolean } = {},
): Promise<RollbackResult> {
  return sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as Tx;
    const users = await tx<{ id: string; is_ai: boolean; ai_kind: string | null; has_identity: boolean }[]>`
      SELECT u.id, u.is_ai, u.ai_kind,
             EXISTS (SELECT 1 FROM user_identities ui WHERE ui.user_id = u.id) AS has_identity
      FROM synthetic_player_profiles spp
      JOIN users u ON u.id = spp.user_id
      WHERE spp.schedule->>'batch' = ${batch}
    `;
    const candidates = users.length;

    // Safety: refuse if ANY selected row is not a persistent bot, or has an
    // identity. Rollback must be structurally incapable of deleting a real user.
    const bad = users.filter((u) => !(u.is_ai && u.ai_kind === 'persistent') || u.has_identity);
    if (bad.length > 0) {
      return {
        batch,
        candidates,
        deleted: 0,
        refusedReason: `${bad.length} selected rows are not identity-free persistent bots; refusing to delete anything`,
      };
    }

    if (opts.dry || candidates === 0) {
      return { batch, candidates, deleted: 0 };
    }

    const ids = users.map((u) => u.id);
    // Detach any matches that reference these bots as winner (mirrors cleanup_ai_users).
    await tx`UPDATE matches SET winner_user_id = NULL WHERE winner_user_id = ANY(${ids})`;
    await tx`DELETE FROM lobbies WHERE host_user_id = ANY(${ids})`;
    const del = await tx`DELETE FROM users WHERE id = ANY(${ids})`;
    return { batch, candidates, deleted: del.count };
  }) as Promise<RollbackResult>;
}

async function main() {
  const batch = argVal('--batch');
  if (!batch) throw new Error('--batch <tag> is required');
  const dry = process.argv.includes('--dry');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const sql = postgres(databaseUrl, { max: 2 });
  try {
    const r = await rollbackBatch(sql, batch, { dry });
    if (r.refusedReason) {
      process.stderr.write(`REFUSED: ${r.refusedReason}\n`);
      process.exit(2);
    }
    process.stdout.write(
      dry
        ? `[--dry] Batch "${batch}": ${r.candidates} candidate bots would be deleted.\n`
        : `Batch "${batch}": deleted ${r.deleted} of ${r.candidates} candidate bots (cascades cleaned profiles/reservations).\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`rollback failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
