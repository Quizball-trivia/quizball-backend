import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { runMigrations } from '../../scripts/run-migrations.mjs';
import { classifyMigration, sqlStatements, migrationConnection } from '../../scripts/migration-safety.mjs';

test('SQL classification ignores comments, literals and function bodies', () => {
  for (const body of [
    '-- NOT CONCURRENTLY\nSET LOCAL lock_timeout = \'5s\'; CREATE TABLE t(id int);',
    "SELECT 'CONCURRENTLY; VACUUM';",
    "DO $block$ BEGIN PERFORM 'CREATE INDEX CONCURRENTLY'; END $block$;",
    '/* outer /* CONCURRENTLY */ still comment */ SELECT 1;',
  ]) assert.equal(classifyMigration(body).nonTransactional, false);
  assert.equal(sqlStatements('SELECT \'a;\'\';b\'; SELECT "a;b";').length, 2);
  assert.equal(classifyMigration('CREATE INDEX CONCURRENTLY i ON t(id);').nonTransactional, true);
  assert.throws(() => classifyMigration('SET lock_timeout = \'5s\'; CREATE INDEX CONCURRENTLY i ON t(id);'), /standalone/);
  assert.throws(() => classifyMigration('-- migrate:no-transaction\nSET LOCAL lock_timeout=\'5s\';'), /SET LOCAL/);
  assert.throws(() => classifyMigration('BEGIN; SELECT 1; COMMIT;'), /boundaries/);
  assert.throws(() => sqlStatements('DO $$ no close'), /Unterminated/);
});

test('connection guard rejects transaction pooling and project mismatches without exposing credentials', () => {
  const app = 'postgresql://postgres.prodref:secret@aws-1-eu-central-1.pooler.supabase.com:6543/postgres';
  const session = app.replace(':6543/', ':5432/');
  assert.throws(() => migrationConnection({DATABASE_URL: app}), /session pooler/);
  assert.throws(() => migrationConnection({DATABASE_URL: 'postgresql://postgres:secret@db.prodref.supabase.co:6543/postgres'}), /session pooler/);
  assert.equal(migrationConnection({DATABASE_URL: app, MIGRATION_DATABASE_URL: session, MIGRATION_EXPECTED_PROJECT_REF: 'prodref'}), session);
  assert.throws(() => migrationConnection({DATABASE_URL: app, MIGRATION_DATABASE_URL: session.replace('prodref', 'stage')}), /projects differ/);
  assert.throws(() => migrationConnection({DATABASE_URL: session, MIGRATION_EXPECTED_PROJECT_REF: 'stage'}), /expected project/);
});

// An explicit loopback target is mandatory. Every case creates and drops ONLY
// its own randomly named database; no shared fixtures are truncated.
const input = process.env.MIGRATION_TEST_ADMIN_URL;
if (!input) throw new Error('Set MIGRATION_TEST_ADMIN_URL to an isolated local PostgreSQL cluster');
const target = new URL(input);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Migration tests are local-only');
const admin = postgres(input, {max: 1, onnotice: () => {}});
async function fixture(fn) {
  const name = `rehearsal_migrations_${randomUUID().replaceAll('-', '')}`;
  const directory = await mkdtemp(join(tmpdir(), 'quizball-migrations-'));
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(input); url.pathname = `/${name}`;
  const sql = postgres(url.toString(), {max: 1, onnotice: () => {}});
  const env = {DATABASE_URL: url.toString(), MIGRATION_LOCK_TIMEOUT_MS: '250', MIGRATION_STATEMENT_TIMEOUT_MS: '5000'};
  const file = (version, body) => writeFile(join(directory, `${version}_test.sql`), body);
  const run = (options = {}) => runMigrations({directory, env, log: () => {}, ...options});
  try { await fn({sql, env, file, run}); }
  finally {
    await sql.end({timeout: 2});
    await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await rm(directory, {recursive: true});
  }
}

test('migration execution and failure recovery on real PostgreSQL', async t => {
  try {
    await t.test('dry run performs no schema writes', () => fixture(async ({sql,file,run}) => {
      await file('100', 'CREATE TABLE proof(id int);');
      const result = await run({dryRun: true});
      assert.equal(result.pending.length, 1);
      const [r] = await sql`SELECT to_regclass('public.proof') proof, to_regclass('supabase_migrations.schema_migrations') ledger`;
      assert.equal(r.proof, null); assert.equal(r.ledger, null);
    }));
    await t.test('online index completes and re-running does nothing', () => fixture(async ({sql,file,run}) => {
      await file('100', 'CREATE TABLE proof(id int);');
      await file('101', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS proof_idx ON proof(id);');
      assert.equal((await run()).applied.length, 2);
      assert.equal((await run()).applied.length, 0);
      const [i] = await sql`SELECT indisvalid FROM pg_index WHERE indexrelid='proof_idx'::regclass`;
      assert.equal(i.indisvalid, true);
    }));
    await t.test('SQL failure rolls back its file and ledger, retaining earlier files', () => fixture(async ({sql,file,run}) => {
      await file('100', 'CREATE TABLE proof(id int);');
      await file('101', 'INSERT INTO proof VALUES(1); SELECT 1/0;');
      await assert.rejects(run(), /division by zero/);
      assert.equal((await sql`SELECT * FROM proof`).length, 0);
      assert.deepEqual((await sql`SELECT version FROM supabase_migrations.schema_migrations`).map(x => x.version), ['100']);
      await file('101', 'INSERT INTO proof VALUES(1);');
      await run(); assert.equal((await sql`SELECT * FROM proof`).length, 1);
    }));
    await t.test('nontransactional validation releases preceding DDL locks before a long scan', () => fixture(async ({sql,file,run}) => {
      await file('100', 'CREATE TABLE proof(id int);'); await run();
      await file('101', '-- migrate:no-transaction\nALTER TABLE proof ADD COLUMN IF NOT EXISTS extra int; SELECT pg_sleep(1);');
      const running = run();
      let scanning = false;
      for (let n=0; n<100; n++) {
        const [r] = await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='quizball-migrations' AND query LIKE '%pg_sleep%' AND state='active') AS scanning`;
        if (r.scanning) { scanning = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      try {
        assert.equal(scanning, true);
        await sql.begin(async tx => {
          await tx.unsafe("SET LOCAL lock_timeout='150ms'");
          await tx`INSERT INTO proof(id) VALUES(1)`;
        });
      } finally { await running; }
      assert.equal((await sql`SELECT * FROM proof`).length, 1);
      assert.equal((await run()).applied.length, 0);
    }));
    await t.test('SQL success before failed ledger insert can be safely retried', () => fixture(async ({sql,file,run}) => {
      await file('100', 'CREATE TABLE proof(id int);'); await run();
      await sql.unsafe(`CREATE FUNCTION refuse_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected ledger failure'; END $$;
        CREATE TRIGGER refuse_ledger BEFORE INSERT ON supabase_migrations.schema_migrations FOR EACH ROW EXECUTE FUNCTION refuse_ledger();`);
      await file('101', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS proof_idx ON proof(id);');
      await assert.rejects(run(), /injected ledger failure/);
      assert.equal((await sql`SELECT version FROM supabase_migrations.schema_migrations WHERE version='101'`).length, 0);
      await sql.unsafe('DROP TRIGGER refuse_ledger ON supabase_migrations.schema_migrations');
      assert.equal((await run()).applied.length, 1);
      assert.equal((await run()).applied.length, 0);
    }));
    await t.test('invalid online indexes stop retries until explicitly repaired', () => fixture(async ({sql,file,run}) => {
      await file('100', 'CREATE TABLE proof(id int); INSERT INTO proof VALUES(1),(1);'); await run();
      await file('101', 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS proof_idx ON proof(id);');
      await assert.rejects(run(), /could not create unique index/);
      await assert.rejects(run(), /Invalid indexes/);
      await sql.unsafe('DROP INDEX CONCURRENTLY proof_idx');
      await sql.unsafe('DELETE FROM proof WHERE ctid IN (SELECT ctid FROM proof LIMIT 1)');
      assert.equal((await run()).applied.length, 1);
    }));
    await t.test('bounded lock wait protects concurrent writers and leaves no partial DDL', () => fixture(async ({sql,file,run}) => {
      await file('100', 'CREATE TABLE proof(id int); INSERT INTO proof VALUES(1);'); await run();
      await file('101', 'ALTER TABLE proof ADD COLUMN new_value int;');
      await sql.begin(async tx => {
        await tx`UPDATE proof SET id=2`;
        await assert.rejects(run(), /lock timeout/);
        await tx`UPDATE proof SET id=3`;
      });
      const columns = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='proof'`;
      assert.deepEqual(columns.map(x => x.column_name), ['id']);
      assert.equal((await run()).applied.length, 1);
    }));
    await t.test('two concurrent deploys cannot apply the same files', () => fixture(async ({sql,file,run}) => {
      await file('100', 'CREATE TABLE proof(id int); SELECT pg_sleep(1); INSERT INTO proof VALUES(1);');
      const first = run();
      let running = false;
      for (let n=0; n<100; n++) {
        const [r] = await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='quizball-migrations' AND query LIKE '%pg_sleep%' AND state='active') AS running`;
        if (r.running) { running = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(running, true);
      await assert.rejects(run(), /holds the release lock/);
      await first; assert.equal((await run()).applied.length, 0);
      assert.equal((await sql`SELECT * FROM proof`).length, 1);
    }));
    await t.test('statement timeout rolls back the file', () => fixture(async ({sql,file,run,env}) => {
      await file('100', 'CREATE TABLE proof(id int); SELECT pg_sleep(1);');
      await assert.rejects(run({env: {...env, MIGRATION_STATEMENT_TIMEOUT_MS: '100'}}), /statement timeout/);
      const [r] = await sql`SELECT to_regclass('proof') AS relation`; assert.equal(r.relation, null);
    }));
    await t.test('connection loss aborts without applying later files; explicit retry resumes', () => fixture(async ({sql,file,run}) => {
      await file('100', 'CREATE TABLE proof(id int);'); await run();
      await file('101', 'INSERT INTO proof VALUES(1); SELECT pg_sleep(3);');
      await file('102', 'CREATE TABLE must_wait(id int);');
      const failed = assert.rejects(run(), /connection|terminating/i);
      let stopped = false;
      for (let n=0; n<100; n++) {
        const targets = await sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='quizball-migrations' AND state='active' AND query LIKE '%pg_sleep%'`;
        if (targets.length) {
          assert.equal(targets.length, 1);
          await sql`SELECT pg_terminate_backend(${targets[0].pid})`;
          stopped = true; break;
        }
        await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(stopped, true); await failed;
      assert.equal((await sql`SELECT * FROM proof`).length, 0);
      const [r] = await sql`SELECT to_regclass('must_wait') AS relation`; assert.equal(r.relation, null);
      assert.deepEqual((await sql`SELECT version FROM supabase_migrations.schema_migrations`).map(x=>x.version), ['100']);
      await file('101', 'INSERT INTO proof VALUES(1);');
      assert.equal((await run()).applied.length, 2);
    }));
  } finally { await admin.end({timeout: 2}); }
});
