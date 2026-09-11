import { readFileSync } from 'node:fs';
import { beforeAll,beforeEach,afterAll,describe,it,expect,vi } from 'vitest';
vi.mock('../../src/db/index.js',async()=>{
  const {default:postgres}=await import('postgres');
  return {sql:postgres(process.env.SEASON3_TEST_DATABASE_URL!,{prepare:false,max:4})};
});
import { sql } from '../../src/db/index.js';
import { season3Repo } from '../../src/modules/feedback/season3.repo.js';
const u='11111111-1111-4111-8111-111111111111',m='22222222-2222-4222-8222-222222222222';
describe.skipIf(!process.env.SEASON3_TEST_DATABASE_URL)('Season 3 isolated database',()=>{
  beforeAll(async()=>{
    const url=new URL(process.env.SEASON3_TEST_DATABASE_URL!);
    if(!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.includes('season3_test'))throw new Error('Isolated local test DB required');
    await sql.unsafe('CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY); CREATE TABLE IF NOT EXISTS matches(id uuid PRIMARY KEY,mode text,status text,is_dev boolean,ended_at timestamptz); CREATE TABLE IF NOT EXISTS match_players(match_id uuid,user_id uuid);');
    await sql.unsafe(readFileSync('supabase/migrations/20260911190431_season3_player_surveys.sql','utf8'));
    // Idempotency of the deployment migration.
    await sql.unsafe(readFileSync('supabase/migrations/20260911190431_season3_player_surveys.sql','utf8'));
  });
  beforeEach(async()=>{
    await sql.unsafe('TRUNCATE season3_survey_responses,season3_survey_state,match_players,matches,users CASCADE');
    await sql`INSERT INTO users VALUES(${u})`;
    await sql`INSERT INTO matches VALUES(${m},'ranked','completed',false,now())`;
    await sql`INSERT INTO match_players VALUES(${m},${u})`;
  });
  afterAll(async()=>{await sql.end();});
  const vote={matchId:m,locale:'en' as const,kind:'vote' as const,removeOrder:false,removeWho:true};
  it('rejects foreign, dev, incomplete and stale matches',async()=>{
    expect((await season3Repo.act(u,'33333333-3333-4333-8333-333333333333','claim')).kind).toBeNull();
    await sql`UPDATE matches SET is_dev=true`;expect((await season3Repo.act(u,m,'claim')).kind).toBeNull();
    await sql`UPDATE matches SET is_dev=false,status='active'`;expect((await season3Repo.act(u,m,'claim')).kind).toBeNull();
    await sql`UPDATE matches SET status='completed',ended_at=now()-interval '1 hour'`;expect((await season3Repo.act(u,m,'claim')).kind).toBeNull();
  });
  it('serializes duplicate submissions and never switches the same match to idea',async()=>{
    await season3Repo.act(u,m,'claim');
    const results=await Promise.all([season3Repo.act(u,m,'submit',vote),season3Repo.act(u,m,'submit',vote)]);
    expect(results.every(r=>r.saved)).toBe(true);
    expect((await sql`SELECT * FROM season3_survey_responses`).length).toBe(1);
    expect((await season3Repo.act(u,m,'claim')).kind).toBeNull();
  });
  it('persists shared snooze even after match expires',async()=>{
    await season3Repo.act(u,m,'claim');await sql`UPDATE matches SET ended_at=now()-interval '1 hour'`;
    await season3Repo.act(u,m,'dismiss');await sql`UPDATE matches SET ended_at=now()`;
    expect((await season3Repo.act(u,m,'claim')).kind).toBeNull();
  });
  it('keeps ambiguous old deliveries out of automatic retry',async()=>{
    await sql`INSERT INTO season3_survey_responses(user_id,match_id,kind,locale,idea,email_status,first_attempt_at,attempted_at)
    VALUES(${u},${m},'idea','en','Team mode','sending',now()-interval '24 hours',now()-interval '10 minutes')`;
    expect(await season3Repo.claimEmail()).toBeUndefined();
    expect((await sql`SELECT email_status FROM season3_survey_responses`)[0]!.email_status).toBe('review');
  });
  it('only one worker claims a pending email',async()=>{
    await sql`INSERT INTO season3_survey_responses(user_id,match_id,kind,locale,idea,email_status) VALUES(${u},${m},'idea','en','Team mode','pending')`;
    const rows=await Promise.all([season3Repo.claimEmail(),season3Repo.claimEmail()]);expect(rows.filter(Boolean)).toHaveLength(1);
  });
  it('ignores stale worker completion after a lease is reclaimed',async()=>{
    await sql`INSERT INTO season3_survey_responses(user_id,match_id,kind,locale,idea,email_status) VALUES(${u},${m},'idea','en','Team mode','pending')`;
    const a=(await season3Repo.claimEmail())!;
    await sql`UPDATE season3_survey_responses SET attempted_at=now()-interval '6 minutes'`;
    const b=(await season3Repo.claimEmail())!;
    await season3Repo.finishEmail(b.id,b.claim_token,true);
    await season3Repo.finishEmail(a.id,a.claim_token,false);
    expect((await sql`SELECT email_status FROM season3_survey_responses`)[0]!.email_status).toBe('sent');
  });
});
