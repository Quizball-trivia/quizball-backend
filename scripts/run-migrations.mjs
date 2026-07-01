#!/usr/bin/env node
/**
 * Apply pending SQL migrations against DATABASE_URL, recording each in
 * supabase_migrations.schema_migrations — the same table the Supabase CLI uses,
 * so this runner and `supabase db push` stay interchangeable.
 *
 * Why this exists: the Supabase CLI is a dev-only tool and is NOT present in the
 * Railway deploy image, so `supabase db push` can't run there. This runner needs
 * only DATABASE_URL (already set in Railway) and the `postgres` client we already
 * depend on. Wired as Railway's preDeployCommand so migrations run once, before
 * the new server version starts.
 *
 * Behaviour:
 *  - Reads supabase/migrations/*.sql, sorted by filename (timestamp-prefixed).
 *  - Skips any whose version (the leading <digits> of the filename) is already
 *    recorded — so it's idempotent and safe to run on every deploy.
 *  - Applies each pending file inside its own transaction and records the
 *    version in the same commit. A failure aborts that migration and exits
 *    non-zero, which fails the deploy (the server never starts on a half-applied
 *    or wrong schema) — matching `ON_ERROR_STOP` semantics.
 *
 * Usage: node scripts/run-migrations.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[migrate] DATABASE_URL is not set — cannot run migrations.');
  process.exit(1);
}

// Parse the Supabase-style version: the leading run of digits in the filename
// (e.g. "20260629120000_fix_draw_miscount.sql" -> "20260629120000").
function versionOf(filename) {
  const match = filename.match(/^(\d+)/);
  return match ? match[1] : null;
}

// A migration must run OUTSIDE a transaction when it uses a statement that
// Postgres forbids inside a transaction block (CREATE/DROP INDEX CONCURRENTLY,
// VACUUM, etc.) or when it opts out explicitly via a leading marker comment.
// Such files are applied statement-by-statement with autocommit; they are NOT
// atomic, so they must be written defensively (IF NOT EXISTS, etc.).
function isNonTransactional(body) {
  return (
    /^\s*--\s*migrate:no-transaction\b/im.test(body) ||
    /\bCONCURRENTLY\b/i.test(body) ||
    /^\s*VACUUM\b/im.test(body)
  );
}

// Advisory-lock key (arbitrary 64-bit constant) so only one deploy applies
// migrations at a time — concurrent deploys would otherwise read the same
// applied set and try to run the same DDL.
const MIGRATION_LOCK_KEY = 472636120260629n;

async function main() {
  const sql = postgres(DATABASE_URL, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 15,
    // A migration may run long; don't let the client time it out.
    statement_timeout: 0,
  });

  try {
    // The tracking table is created by Supabase; ensure it exists so a fresh DB
    // (or one never touched by the CLI) still works.
    await sql.unsafe(`
      CREATE SCHEMA IF NOT EXISTS supabase_migrations;
      CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
        version text PRIMARY KEY,
        statements text[],
        name text
      );
    `);

    // Serialize across concurrent deploys: only the holder of this session-level
    // advisory lock applies migrations; others block here until it's released,
    // then find nothing pending. Acquired AFTER the table exists, BEFORE we read
    // the applied set.
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // Validate up front. A missing numeric version is a hard error — such a file
    // would never be tracked and would re-run on every deploy. A duplicate
    // version is only a warning: two files sharing a version is messy, but it
    // doesn't break the apply (both files run; schema_migrations records the
    // version once via ON CONFLICT), and a few such collisions already exist in
    // history — failing here would block all deploys over a pre-existing issue.
    const seen = new Map();
    for (const f of files) {
      const v = versionOf(f);
      if (!v) {
        throw new Error(`Migration filename has no numeric version prefix: ${f}`);
      }
      if (seen.has(v)) {
        console.warn(
          `[migrate] WARNING: duplicate migration version ${v}: ${seen.get(v)} and ${f}`,
        );
      } else {
        seen.set(v, f);
      }
    }

    const applied = new Set(
      (await sql`SELECT version FROM supabase_migrations.schema_migrations`).map(
        (r) => r.version,
      ),
    );

    const pending = files.filter((f) => !applied.has(versionOf(f)));

    if (pending.length === 0) {
      console.log('[migrate] No pending migrations. Schema is up to date.');
      return;
    }

    console.log(`[migrate] ${pending.length} pending migration(s): ${pending.join(', ')}`);

    for (const file of pending) {
      const version = versionOf(file);
      const name = file.replace(/^\d+_?/, '').replace(/\.sql$/, '');
      const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

      console.log(`[migrate] Applying ${file} ...`);
      if (isNonTransactional(body)) {
        // Can't wrap in a transaction (e.g. CREATE INDEX CONCURRENTLY). Run as-is
        // with autocommit, then record the version in a separate statement. These
        // files must be idempotent (IF NOT EXISTS) since they aren't atomic.
        console.log(`[migrate]   (non-transactional — running without BEGIN/COMMIT)`);
        await sql.unsafe(body);
        await sql`
          INSERT INTO supabase_migrations.schema_migrations (version, name)
          VALUES (${version}, ${name})
          ON CONFLICT (version) DO NOTHING
        `;
      } else {
        await sql.begin(async (tx) => {
          await tx.unsafe(body);
          await tx`
            INSERT INTO supabase_migrations.schema_migrations (version, name)
            VALUES (${version}, ${name})
            ON CONFLICT (version) DO NOTHING
          `;
        });
      }
      console.log(`[migrate] ✓ ${file}`);
    }

    console.log('[migrate] All pending migrations applied.');
  } finally {
    // Best-effort unlock; the session-level lock is also released when sql.end()
    // closes the connection.
    try {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    } catch {
      /* connection may already be closing */
    }
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[migrate] Migration failed:', err?.message ?? err);
  process.exit(1);
});
