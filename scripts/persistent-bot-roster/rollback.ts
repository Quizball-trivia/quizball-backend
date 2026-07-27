/**
 * Roster ROLLBACK script — receipt + manifest driven (finding #4).
 *
 * Deletes ONLY the user ids recorded in the creation RECEIPT (never a mutable
 * batch-string scan). Requires the manifest too, and inside ONE locking
 * transaction, per id verifies:
 *   - the id is present in the receipt AND the receipt's manifestDigest matches
 *     the supplied manifest (receipt belongs to this manifest)
 *   - the row FOR UPDATE is is_ai=true AND ai_kind='persistent' AND has no
 *     user_identities AND its nickname matches the manifest row for that index
 *   - it has NO active reservation / lobby / live match (always refuse)
 *   - it has NO gameplay references (match_players, friendships, ranked_rp_changes)
 *     — refused unless --force
 *
 * Receipts are PER-ENVIRONMENT artifacts (the user ids differ per environment);
 * use the staging receipt to roll back staging, the prod receipt for prod.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/persistent-bot-roster/rollback.ts \
 *     --receipt out/receipt-<batch>.json --manifest out/roster.manifest.json \
 *     [--force] [--dry]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import postgres from 'postgres';

import type { SqlLike, Tx } from './db-types.js';
import type { RosterManifest } from './manifest.js';
import { rosterDigest, sha256 } from './manifest.js';
import type { RosterPatterns } from './patterns.js';
import { generateRoster, normalizeForExclusion } from './roster.js';

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export interface RosterReceipt {
  schemaVersion: 1;
  batch: string;
  manifestDigest: string;
  rosterSha256: string;
  count: number;
  createdAt: string;
  userIds: string[];
}

export interface RollbackResult {
  candidates: number;
  deleted: number;
  refusedReason?: string;
  /** Ids skipped because they carry gameplay references (only when !force). */
  gameplayReferenced?: string[];
}

export interface RollbackInputs {
  receipt: RosterReceipt;
  /** Expected lowercased nicknames by user id (from regenerating the manifest). */
  expectedNickByAny: Set<string>;
  force: boolean;
  dry: boolean;
}

/**
 * Roll back exactly the receipt's ids in one locking transaction. Exported for
 * the integration test.
 */
export async function rollbackReceipt(sql: SqlLike, inputs: RollbackInputs): Promise<RollbackResult> {
  const { receipt, expectedNickByAny, force, dry } = inputs;
  const ids = receipt.userIds;
  if (ids.length === 0) return { candidates: 0, deleted: 0 };

  return (await sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as Tx;

    // Lock the exact rows and gather everything needed to validate them.
    const rows = await tx<{
      id: string; is_ai: boolean; ai_kind: string | null; nick: string | null;
      has_identity: boolean; batch: string | null;
      has_reservation: boolean; hosts_lobby: boolean; in_live_match: boolean;
      gameplay_refs: number;
    }[]>`
      SELECT
        u.id, u.is_ai, u.ai_kind, lower(u.nickname) AS nick,
        EXISTS (SELECT 1 FROM user_identities ui WHERE ui.user_id = u.id) AS has_identity,
        spp.schedule->>'batch' AS batch,
        EXISTS (SELECT 1 FROM synthetic_bot_reservations r WHERE r.bot_user_id = u.id) AS has_reservation,
        EXISTS (SELECT 1 FROM lobbies l WHERE l.host_user_id = u.id) AS hosts_lobby,
        EXISTS (
          SELECT 1 FROM match_players mp JOIN matches m ON m.id = mp.match_id
          WHERE mp.user_id = u.id AND m.status = 'active'
        ) AS in_live_match,
        (
          (SELECT count(*) FROM match_players mp WHERE mp.user_id = u.id)
          + (SELECT count(*) FROM friendships f WHERE f.user_low_id = u.id OR f.user_high_id = u.id)
          + (SELECT count(*) FROM ranked_rp_changes rc WHERE rc.user_id = u.id)
        )::int AS gameplay_refs
      FROM users u
      LEFT JOIN synthetic_player_profiles spp ON spp.user_id = u.id
      WHERE u.id = ANY(${ids}::uuid[])
      FOR UPDATE OF u
    `;

    const candidates = rows.length;

    // Every receipt id must still exist.
    if (rows.length !== ids.length) {
      return {
        candidates,
        deleted: 0,
        refusedReason: `receipt lists ${ids.length} ids but ${rows.length} still exist; refusing (manual tampering or wrong environment)`,
      };
    }

    // Per-id identity/classification/nickname validation (fail closed).
    const bad = rows.filter(
      (r) =>
        !(r.is_ai && r.ai_kind === 'persistent') ||
        r.has_identity ||
        r.batch !== receipt.batch ||
        !r.nick ||
        !expectedNickByAny.has(r.nick),
    );
    if (bad.length > 0) {
      return {
        candidates,
        deleted: 0,
        refusedReason:
          `${bad.length} id(s) are not identity-free persistent bots of this batch whose nickname matches the manifest; ` +
          'refusing to delete anything',
      };
    }

    // Never delete a bot with an active reservation / hosted lobby / live match.
    const busy = rows.filter((r) => r.has_reservation || r.hosts_lobby || r.in_live_match);
    if (busy.length > 0) {
      return {
        candidates,
        deleted: 0,
        refusedReason: `${busy.length} bot(s) have an active reservation, hosted lobby, or live match; refusing`,
      };
    }

    // Gameplay-referenced bots are refused unless --force.
    const referenced = rows.filter((r) => r.gameplay_refs > 0).map((r) => r.id);
    if (referenced.length > 0 && !force) {
      return {
        candidates,
        deleted: 0,
        gameplayReferenced: referenced,
        refusedReason:
          `${referenced.length} bot(s) have gameplay history (match_players/friendships/rp_changes). ` +
          'Deleting cascades that history. Re-run with --force to proceed.',
      };
    }

    if (dry) return { candidates, deleted: 0, gameplayReferenced: referenced };

    // Detach winner references, then delete; profiles/reservations/ranked rows
    // cascade via ON DELETE CASCADE on the users row.
    await tx`UPDATE matches SET winner_user_id = NULL WHERE winner_user_id = ANY(${ids}::uuid[])`;
    await tx`DELETE FROM lobbies WHERE host_user_id = ANY(${ids}::uuid[])`;
    const del = await tx`DELETE FROM users WHERE id = ANY(${ids}::uuid[])`;
    return { candidates, deleted: del.count, gameplayReferenced: referenced };
  })) as RollbackResult;
}

/** Rebuild the manifest's expected lowercased nickname set (provenance check). */
export function expectedNicknames(manifestPath: string, patternsPath: string): {
  manifest: RosterManifest;
  nicks: Set<string>;
} {
  const manifestRaw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw) as RosterManifest;
  const patternsRaw = readFileSync(patternsPath, 'utf8');
  if (sha256(patternsRaw) !== manifest.patternsSha256) {
    throw new Error('patterns.json does not match manifest.patternsSha256; refusing.');
  }
  const patterns = JSON.parse(patternsRaw) as RosterPatterns;
  const bots = generateRoster({ seed: manifest.seed, count: manifest.count, patterns });
  if (rosterDigest(bots) !== manifest.rosterSha256) {
    throw new Error('regenerated roster does not match manifest.rosterSha256; refusing.');
  }
  return { manifest, nicks: new Set(bots.map((b) => normalizeForExclusion(b.nickname))) };
}

function openWriteDb(): postgres.Sql {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return postgres(databaseUrl, {
    max: 2,
    prepare: false,
    onnotice: () => {},
    connection: { application_name: 'roster-rollback', statement_timeout: 120_000 },
  });
}

async function main() {
  const receiptArg = argVal('--receipt');
  const manifestArg = argVal('--manifest');
  const patternsArg = argVal('--patterns') ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'patterns.json');
  if (!receiptArg) throw new Error('--receipt <receipt-*.json> is required');
  if (!manifestArg) throw new Error('--manifest <roster.manifest.json> is required');
  const force = process.argv.includes('--force');
  const dry = process.argv.includes('--dry');

  const receiptPath = path.resolve(process.cwd(), receiptArg);
  const manifestPath = path.resolve(process.cwd(), manifestArg);
  const patternsPath = path.resolve(process.cwd(), patternsArg);

  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as RosterReceipt;
  const { manifest, nicks } = expectedNicknames(manifestPath, patternsPath);
  if (receipt.manifestDigest !== sha256(readFileSync(manifestPath, 'utf8'))) {
    throw new Error('receipt.manifestDigest does not match the supplied manifest; wrong pairing. Refusing.');
  }
  if (receipt.rosterSha256 !== manifest.rosterSha256) {
    throw new Error('receipt.rosterSha256 does not match manifest.rosterSha256; refusing.');
  }

  const sql = openWriteDb();
  try {
    const r = await rollbackReceipt(sql, { receipt, expectedNickByAny: nicks, force, dry });
    if (r.refusedReason) {
      process.stderr.write(`REFUSED: ${r.refusedReason}\n`);
      if (r.gameplayReferenced?.length) {
        process.stderr.write(`Gameplay-referenced ids: ${r.gameplayReferenced.slice(0, 20).join(', ')}\n`);
      }
      process.exit(2);
    }
    process.stdout.write(
      dry
        ? `[--dry] Receipt "${receipt.batch}": ${r.candidates} bots would be deleted` +
            (r.gameplayReferenced?.length ? ` (${r.gameplayReferenced.length} carry gameplay history)` : '') +
            '.\n'
        : `Receipt "${receipt.batch}": deleted ${r.deleted} of ${r.candidates} bots (cascaded profiles/reservations/ranked rows).\n`,
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
