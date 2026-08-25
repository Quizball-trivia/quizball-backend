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

// Prefer DATABASE_URL (what the app uses); fall back to STAGING_DATABASE_URL,
// which some environments set instead. If neither is present, list the env var
// NAMES that look DB-related (never their values) so a failed pre-deploy is
// diagnosable — Railway pre-deploy steps don't always inherit every var.
const DATABASE_URL = process.env.DATABASE_URL || process.env.STAGING_DATABASE_URL;
if (!DATABASE_URL) {
  const dbVarNames = Object.keys(process.env)
    .filter((k) => /DATABASE|POSTGRES|SUPABASE|PG/i.test(k))
    .sort();
  console.error(
    '[migrate] Neither DATABASE_URL nor STAGING_DATABASE_URL is set — cannot run migrations.',
  );
  console.error(
    `[migrate] DB-related env var names present: ${dbVarNames.length ? dbVarNames.join(', ') : '(none)'}`,
  );
  process.exit(1);
}

// Supabase's transaction pooler (port 6543) reapplies role-level timeouts for
// each statement and cannot preserve SET commands for online DDL. Its session
// pooler uses the same host and credentials on port 5432 and pins one backend
// for the lifetime of this client. An explicit URL remains the escape hatch for
// providers with a different topology.
function nonTransactionalDatabaseUrl(databaseUrl) {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL;
  const parsed = new URL(databaseUrl);
  if (parsed.hostname.endsWith('.pooler.supabase.com') && parsed.port === '6543') {
    parsed.port = '5432';
  }
  return parsed.toString();
}

const NON_TRANSACTIONAL_DATABASE_URL = nonTransactionalDatabaseUrl(DATABASE_URL);
const parsedOnlineDdlLockTimeoutMs = Number.parseInt(
  process.env.MIGRATION_ONLINE_DDL_LOCK_TIMEOUT_MS ?? '',
  10,
);
const ONLINE_DDL_LOCK_TIMEOUT_MS = Number.isInteger(parsedOnlineDdlLockTimeoutMs)
  && parsedOnlineDdlLockTimeoutMs > 0
  ? Math.min(parsedOnlineDdlLockTimeoutMs, 15 * 60_000)
  : 120_000;

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

function concurrentIndexTargets(body) {
  const targets = [];
  const pattern = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)/gi;
  for (const match of body.matchAll(pattern)) {
    targets.push({ schema: match[1] ?? 'public', name: match[2] });
  }
  return targets;
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier in concurrent-index migration: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

// Advisory-lock key (arbitrary 64-bit constant) so only one deploy applies
// migrations at a time — concurrent deploys would otherwise read the same
// applied set and try to run the same DDL.
const MIGRATION_LOCK_KEY = 472636120260629n;

async function main() {
  // Normal transactional migrations may use Supavisor's transaction pooler.
  // Online DDL and its session advisory lock use the session-pooler URL so SET,
  // lock, and unlock calls stay on one backend. A session lock creates no
  // long-lived transaction snapshot for CREATE INDEX CONCURRENTLY to await.
  const migrationSql = postgres(DATABASE_URL, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 15,
    prepare: false,
    // These must be startup parameters. A top-level `statement_timeout`
    // option is ignored by postgres.js, leaving the database role's 30-second
    // default in force during CREATE INDEX CONCURRENTLY.
    connection: {
      application_name: 'quizball-migrations',
      statement_timeout: 0,
      lock_timeout: 0,
      idle_in_transaction_session_timeout: 0,
    },
  });
  const lockSql = postgres(NON_TRANSACTIONAL_DATABASE_URL, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 15,
    prepare: false,
    connection: {
      application_name: 'quizball-migration-lock',
      statement_timeout: 0,
      lock_timeout: 0,
      idle_in_transaction_session_timeout: 0,
    },
  });
  const nonTransactionalSql = postgres(NON_TRANSACTIONAL_DATABASE_URL, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 15,
    prepare: false,
    connection: {
      application_name: 'quizball-online-migrations',
    },
  });

  try {
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // Validate up front. A missing numeric version is a hard error — such a file
    // would never be tracked and would re-run on every deploy. Duplicate
    // versions are rejected: schema_migrations uses version as its primary key,
    // so accepting two files under one version could permanently skip the
    // second file if it failed after the first was recorded.
    const seen = new Map();
    for (const f of files) {
      const v = versionOf(f);
      if (!v) {
        throw new Error(`Migration filename has no numeric version prefix: ${f}`);
      }
      if (seen.has(v)) {
        throw new Error(
          `Duplicate migration version ${v}: ${seen.get(v)} and ${f}`,
        );
      }
      seen.set(v, f);
    }

    let migrationLockAcquired = false;
    try {
      await lockSql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
      migrationLockAcquired = true;

      // The tracking table is created by Supabase; ensure it exists so a fresh
      // DB (or one never touched by the CLI) still works. This must happen only
      // after the advisory lock because concurrent IF NOT EXISTS DDL can still
      // race while inserting system-catalog rows.
      await migrationSql.unsafe(`
        CREATE SCHEMA IF NOT EXISTS supabase_migrations;
        CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
          version text PRIMARY KEY,
          statements text[],
          name text
        );
      `);

      const applied = new Set(
        (await migrationSql`SELECT version FROM supabase_migrations.schema_migrations`).map(
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
          // These SETs persist because nonTransactionalSql uses a dedicated
          // session-pooler connection. A bounded lock wait fails the deploy
          // safely; the online build itself may run for as long as required.
          await nonTransactionalSql.unsafe('SET statement_timeout = 0');
          await nonTransactionalSql`
            SELECT set_config(
              'lock_timeout',
              ${`${ONLINE_DDL_LOCK_TIMEOUT_MS}ms`},
              false
            )
          `;
          await nonTransactionalSql.unsafe('SET idle_in_transaction_session_timeout = 0');
          for (const target of concurrentIndexTargets(body)) {
            const qualifiedName = `${target.schema}.${target.name}`;
            const [existingIndex] = await nonTransactionalSql`
              SELECT index_row.indisvalid, index_row.indisready
              FROM pg_catalog.pg_index index_row
              WHERE index_row.indexrelid = pg_catalog.to_regclass(${qualifiedName})
            `;
            if (existingIndex && (!existingIndex.indisvalid || !existingIndex.indisready)) {
              console.warn(`[migrate] Dropping interrupted concurrent index ${qualifiedName}`);
              await nonTransactionalSql.unsafe(
                `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdentifier(target.schema)}.${quoteIdentifier(target.name)}`,
              );
            }
          }
          await nonTransactionalSql.unsafe(body);
          await migrationSql`
            INSERT INTO supabase_migrations.schema_migrations (version, name)
            VALUES (${version}, ${name})
            ON CONFLICT (version) DO NOTHING
          `;
        } else {
          await migrationSql.begin(async (tx) => {
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
      if (migrationLockAcquired) {
        const [unlockResult] = await lockSql`
          SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY}) AS unlocked
        `;
        if (!unlockResult?.unlocked) {
          console.warn('[migrate] Advisory migration lock was not held at release time.');
        }
      }
    }
  } finally {
    await Promise.allSettled([
      migrationSql.end({ timeout: 5 }),
      lockSql.end({ timeout: 5 }),
      nonTransactionalSql.end({ timeout: 5 }),
    ]);
  }
}

// Transient pool exhaustion must not fail a deploy outright: Supavisor's
// session pooler caps clients at 15, and ad-hoc scripts/psql sessions can
// briefly saturate it (three consecutive staging deploys died on
// EMAXCONNSESSION on 2026-08-25 with zero pending migrations). Retry with
// backoff for connection-shaped errors only; real migration failures — SQL
// errors, validation, bad files — still fail on the first attempt.
const RETRYABLE = /EMAXCONNSESSION|ECONNREFUSED|ECONNRESET|ETIMEDOUT|CONNECT_TIMEOUT|max clients/i;
const MAX_ATTEMPTS = 5;

async function run() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await main();
      return;
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (attempt >= MAX_ATTEMPTS || !RETRYABLE.test(msg)) throw err;
      const delayMs = Math.min(60_000, 5_000 * 2 ** (attempt - 1))
        + Math.floor(Math.random() * 2_000);
      console.warn(
        `[migrate] Attempt ${attempt}/${MAX_ATTEMPTS} hit a transient connection error (${msg}); retrying in ${Math.round(delayMs / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

run().catch((err) => {
  console.error('[migrate] Migration failed:', err?.message ?? err);
  process.exit(1);
});
