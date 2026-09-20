import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { buildMediaBindingPlan, applyMediaBindings } from '../../scripts/release/content-media-bindings.mjs';
import { contentHash } from '../../scripts/release/question-manifest.mjs';

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
test('media chunks roll back failed journals, resume committed chunks and retain later edits', { skip: !databaseUrl }, async () => {
  const url = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname), 'Isolated local PostgreSQL required');
  const database = `release_media_test_${Date.now()}_${process.pid}`;
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  url.pathname = `/${database}`;
  const sql = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`
      CREATE TABLE football_players(id uuid PRIMARY KEY, name text, image_url text, updated_at timestamptz);
      CREATE TABLE content_media_binding_batches(id text PRIMARY KEY, target_project text, manifest jsonb);
      CREATE TABLE content_media_binding_rows(
        sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        batch_id text REFERENCES content_media_binding_batches(id), content_batch_id text,
        table_name text, row_id uuid, before_data jsonb, after_data jsonb,
        undo_before_data jsonb, undo_data jsonb, undo_sequence bigint, undone_at timestamptz,
        UNIQUE(batch_id,table_name,row_id)
      );
    `);
    const rows = Array.from({ length: 250 }, (_, n) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      name: `Player ${n}`, image_url: `https://source.example/${n}.jpg`, updated_at: null,
    }));
    await sql`INSERT INTO football_players SELECT * FROM jsonb_populate_recordset(NULL::football_players,${sql.json(rows)})`;
    const mapping = Object.fromEntries(rows.map(row => [row.image_url,
      `https://lfbwhxvwubzeqkztghok.supabase.co/storage/v1/object/public/imgs/releases/${'a'.repeat(64)}/${contentHash(row.id)}.jpg`]));
    const plan = buildMediaBindingPlan(rows.map(before => ({ table: 'football_players', contentBatchId: 'b'.repeat(64), before })), {
      targetProject: 'nsdfiprfmhdqhbfxfwpv', mapping, verificationSha256: 'c'.repeat(64),
    });
    const run = undo => applyMediaBindings(sql, plan, { expectedSha256: plan.sha256, dryRun: false, allowStagingOriginals: true, undo });
    await sql.unsafe(`CREATE FUNCTION fail_second_chunk() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.row_id='${rows[150].id}'::uuid THEN RAISE EXCEPTION 'injected journal failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_second_chunk BEFORE INSERT ON content_media_binding_rows FOR EACH ROW EXECUTE FUNCTION fail_second_chunk();`);
    await assert.rejects(run(false), /injected journal failure/);
    assert.equal((await sql`SELECT count(*)::int n FROM content_media_binding_rows`)[0].n, 100);
    const partial = await sql`SELECT * FROM football_players ORDER BY id`;
    for (let n = 0; n < rows.length; n++) assert.equal(partial[n].image_url, n < 100 ? mapping[rows[n].image_url] : rows[n].image_url);
    await sql`DROP TRIGGER fail_second_chunk ON content_media_binding_rows`;
    const resumed = await run(false);
    assert.equal(resumed.changed, 150);
    assert.equal(resumed.resumed, 100);
    assert.equal((await run(false)).resumed, 250);
    await sql`UPDATE football_players SET name='Later editor value' WHERE id=${rows[10].id}`;
    const undone = await run(true);
    assert.equal(undone.changed, 249);
    assert.deepEqual(undone.needsReview, [rows[10].id]);
    const after = await sql`SELECT * FROM football_players ORDER BY id`;
    assert.equal(after.length, 250);
    for (let n = 0; n < rows.length; n++) {
      assert.equal(after[n].name, n === 10 ? 'Later editor value' : rows[n].name);
      assert.equal(after[n].image_url, n === 10 ? mapping[rows[n].image_url] : rows[n].image_url);
    }
    assert.equal((await run(true)).changed, 0);
  } finally {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE "${database}"`);
    await admin.end({ timeout: 5 });
  }
});
