import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { runMigrations } from '../../scripts/run-migrations.mjs';

const input = process.env.MIGRATION_TEST_ADMIN_URL;
if (!input) throw new Error('Set MIGRATION_TEST_ADMIN_URL to an isolated local cluster');
const target = new URL(input);
if (!['127.0.0.1','localhost','[::1]'].includes(target.hostname)) throw new Error('Release tests are local-only');
const template = process.env.MIGRATION_TEST_TEMPLATE;
if (!/^rehearsal_[a-z0-9_]+$/.test(template ?? '')) throw new Error('Expected a rehearsal schema template');
const admin = postgres(input,{max:1,onnotice:()=>{}});
const name = `rehearsal_sequence_${randomUUID().replaceAll('-','')}`;
const directory = await mkdtemp(join(tmpdir(),'quizball-sequence-'));
const source = new URL('../../supabase/migrations/',import.meta.url);

test('production schema migration sequence preserves old writers at every boundary', async () => {
  let sql;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}" OWNER postgres`);
    const db = new URL(input); db.username='postgres'; db.pathname=`/${name}`;
    sql=postgres(db.toString(),{max:1,onnotice:()=>{}});
    const [definition] = await sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='store_transaction_logs'::regclass AND conname='store_transaction_logs_event_type_check'`;
    const oldEvents=[...definition.definition.matchAll(/'([^']+)'::text/g)].map(x=>x[1]);
    assert.ok(oldEvents.includes('guess_the_goal_reward'));
    const oldQuestionTypes=['mcq_single','true_false','input_text','countdown_list','clue_chain','put_in_order','imposter_multi_select','career_path','high_low','football_logic'];
    const category=randomUUID();
    await sql`INSERT INTO categories(id,slug,name,is_active) VALUES(${category},'release-rehearsal',${sql.json({en:'Release rehearsal'})},true)`;
    for(const event of oldEvents) await sql`INSERT INTO store_transaction_logs(event_type,outcome,coins_delta) VALUES(${event},'success',10)`;
    const [before] = await sql`SELECT count(*)::int AS count, sum(coins_delta)::int AS total FROM store_transaction_logs`;
    const versions=new Set((await sql`SELECT version FROM supabase_migrations.schema_migrations`).map(x=>x.version));
    let applied=0;
    const times=[];
    for(const file of (await readdir(source)).filter(x=>x.endsWith('.sql')).sort()) {
      if(versions.has(file.split('_')[0])) continue;
      const path=join(directory,file); await writeFile(path,await readFile(new URL(file,source)));
      const start=Date.now();
      await runMigrations({directory,env:{DATABASE_URL:db.toString(),MIGRATION_LOCK_TIMEOUT_MS:'1000'},log:()=>{}});
      times.push({file,milliseconds:Date.now()-start}); applied++;
      await rm(path);
      // Roll these probes back, while allowing assertions to fail the test.
      await sql.begin(async tx => {
        await tx`SAVEPOINT writer_probes`;
        for(const event of oldEvents) await tx`INSERT INTO store_transaction_logs(event_type,outcome,coins_delta) VALUES(${event},'success',7)`;
        for(const type of oldQuestionTypes) await tx`INSERT INTO questions(category_id,type,difficulty,prompt) VALUES(${category},${type},'easy',${tx.json({en:'Migration compatibility probe'})})`;
        // These are the existing production application's user-creation shapes.
        await tx`INSERT INTO users(nickname,is_ai,ai_kind) VALUES('migration-human',false,null),('migration-bot',true,'ephemeral')`;
        await tx`INSERT INTO daily_challenge_configs(challenge_type) VALUES('fifaCards'),('cardDetective') ON CONFLICT DO NOTHING`;
        await tx`ROLLBACK TO SAVEPOINT writer_probes`;
      });
    }
    assert.ok(applied>80, 'Must exercise the release, not an already-migrated template');
    const [after] = await sql`SELECT count(*)::int AS count,sum(coins_delta)::int AS total FROM store_transaction_logs`;
    assert.deepEqual(after,before,'Historical wallet rows changed');
    const result=await runMigrations({env:{DATABASE_URL:db.toString()},log:()=>{}});
    assert.equal(result.applied.length,0,'Second run must apply nothing');
    const [invalid]=await sql`SELECT count(*)::int AS count FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT i.indisvalid`;
    assert.equal(invalid.count,0);
    // Guest exclusion is a behavior check, not merely a function-text check.
    await sql`INSERT INTO users(nickname,is_guest,tickets) VALUES('guest-refill-probe',true,0),('member-refill-probe',false,1)`;
    await sql`SELECT refill_tickets_global()`;
    const users=await sql`SELECT nickname,tickets FROM users WHERE nickname IN ('guest-refill-probe','member-refill-probe') ORDER BY nickname`;
    assert.deepEqual(users.map(x=>x.tickets),[0,2]);
    await sql.begin(async tx=>{
      await tx.unsafe('SET LOCAL ROLE service_role');
      await tx`SELECT count(*) FROM pass_chain_players`;
    });
    await assert.rejects(sql.begin(async tx=>{
      await tx.unsafe('SET LOCAL ROLE anon');
      await tx`SELECT count(*) FROM pass_chain_players`;
    }),/permission denied/);
    console.log(JSON.stringify({applied,oldWalletEventTypes:oldEvents.length,oldQuestionTypes:oldQuestionTypes.length,writerBoundaries:applied,slowest:times.sort((a,b)=>b.milliseconds-a.milliseconds).slice(0,5)}));
  } finally {
    if(sql) await sql.end({timeout:2});
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end({timeout:2}); await rm(directory,{recursive:true});
  }
});
