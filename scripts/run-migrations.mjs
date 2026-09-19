#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import postgres from 'postgres';
import { classifyMigration, migrationConnection, timeoutMs } from './migration-safety.mjs';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const MIGRATION_LOCK_KEY = 472636120260629n;

export async function runMigrations({ directory = MIGRATIONS_DIR, env = process.env, dryRun = false, log = console.log } = {}) {
  const databaseUrl = migrationConnection(env);
  const lockTimeout = timeoutMs(env.MIGRATION_LOCK_TIMEOUT_MS, 3000, 'MIGRATION_LOCK_TIMEOUT_MS');
  const statementTimeout = timeoutMs(env.MIGRATION_STATEMENT_TIMEOUT_MS, 300000, 'MIGRATION_STATEMENT_TIMEOUT_MS');
  const files = (await readdir(directory)).filter(f => f.endsWith('.sql')).sort();
  const versions = new Set();
  const migrations = [];
  // Validate names before opening the connection or changing the database.
  for (const file of files) {
    const version = file.match(/^(\d+)_/)?.[1];
    if (!version || versions.has(version)) throw new Error(`Invalid or duplicate migration version: ${file}`);
    versions.add(version);
    migrations.push({ file, version, body: await readFile(join(directory, file), 'utf8') });
  }
  let connectionLost = false, closing = false, locked = false;
  // ONE physical session owns the lock and executes the SQL. No idle
  // coordinator transaction blocks CREATE INDEX CONCURRENTLY. Connection
  // loss aborts: never continue work after losing the migration lock.
  const sql = postgres(databaseUrl, {
    max: 1, idle_timeout: 0, max_lifetime: null, connect_timeout: 15, prepare: false,
    onnotice: () => {}, onclose: () => { if (!closing) connectionLost = true; },
    connection: { application_name: 'quizball-migrations', statement_timeout: statementTimeout, lock_timeout: lockTimeout },
  });
  const guard = () => { if (connectionLost) throw new Error('Migration connection lost; inspect the ledger before retrying'); };
  const query = async (body, args = []) => { guard(); const result = await sql.unsafe(body, args); guard(); return result; };
  const assertIndexes = async () => {
    const invalid = await query(`SELECT n.nspname AS schema, c.relname AS name
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','agents') AND (NOT i.indisvalid OR NOT i.indisready)`);
    if (invalid.length) throw new Error(`Invalid indexes require reviewed repair before retry: ${invalid.map(x => `${x.schema}.${x.name}`).join(', ')}`);
  };
  try {
    const [acquired] = await query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [MIGRATION_LOCK_KEY.toString()]);
    if (!acquired.acquired) throw new Error('Another migration runner holds the release lock');
    locked = true;
    const [ledger] = await query("SELECT to_regclass('supabase_migrations.schema_migrations') AS relation");
    const applied = new Set(ledger.relation ? (await query('SELECT version FROM supabase_migrations.schema_migrations')).map(x => x.version) : []);
    const pending = migrations.filter(x => !applied.has(x.version));
    // Applied historical files remain evidence; classify only pending SQL.
    for (const migration of pending) {
      try { migration.nonTransactional = classifyMigration(migration.body).nonTransactional; }
      catch (error) { throw new Error(`${migration.file}: ${error.message}`); }
    }
    await assertIndexes();
    log(`[migrate] ${pending.length} pending migration(s)${dryRun ? ' (dry run; no writes)' : ''}`);
    if (dryRun) {
      for (const x of pending) log(`[migrate] ${x.file}: ${x.nonTransactional ? 'nontransactional' : 'transactional'}`);
      return { applied: [], pending: pending.map(x => x.file) };
    }
    if (!ledger.relation) await query(`CREATE SCHEMA IF NOT EXISTS supabase_migrations;
      CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY, statements text[], name text);`);
    const completed = [];
    for (const migration of pending) {
      const started = Date.now();
      log(`[migrate] Applying ${migration.file} (${migration.nonTransactional ? 'nontransactional' : 'transactional'})`);
      // Restore budgets per file so historical SET commands cannot leak.
      await query("SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)", [`${lockTimeout}ms`, `${statementTimeout}ms`]);
      let transaction = false;
      try {
        if (!migration.nonTransactional) { await query('BEGIN'); transaction = true; }
        await query(migration.body);
        await assertIndexes();
        await query('INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES($1,$2)', [
          migration.version, migration.file.replace(/^\d+_/, '').replace(/\.sql$/, ''),
        ]);
        if (transaction) { await query('COMMIT'); transaction = false; }
      } catch (error) {
        if (transaction && !connectionLost) await query('ROLLBACK').catch(() => {});
        throw new Error(`${migration.file} failed (${error.code ?? 'error'}): ${error.message}`, {cause: error});
      }
      completed.push(migration.file);
      log(`[migrate] Applied ${migration.file} in ${Date.now() - started}ms`);
    }
    return { applied: completed, pending: [] };
  } finally {
    if (locked && !connectionLost) await query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY.toString()]).catch(() => {});
    closing = true;
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const flags = process.argv.slice(2);
  if (flags.some(flag => flag !== '--dry-run')) {
    console.error('Usage: node scripts/run-migrations.mjs [--dry-run]'); process.exitCode = 1;
  } else {
    runMigrations({dryRun: flags.includes('--dry-run')}).catch(error => {
      console.error('[migrate]', error.message); process.exitCode = 1;
    });
  }
}
