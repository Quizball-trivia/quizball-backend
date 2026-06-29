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

    const applied = new Set(
      (await sql`SELECT version FROM supabase_migrations.schema_migrations`).map(
        (r) => r.version,
      ),
    );

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const pending = files.filter((f) => {
      const v = versionOf(f);
      return v && !applied.has(v);
    });

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
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`
          INSERT INTO supabase_migrations.schema_migrations (version, name)
          VALUES (${version}, ${name})
          ON CONFLICT (version) DO NOTHING
        `;
      });
      console.log(`[migrate] ✓ ${file}`);
    }

    console.log('[migrate] All pending migrations applied.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[migrate] Migration failed:', err?.message ?? err);
  process.exit(1);
});
