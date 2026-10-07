import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { sql } from '../../src/db/index.js';
import { mobilePushRepo as repo } from '../../src/modules/notifications/mobile-push.repo.js';
import { decryptPushToken, encryptPushToken, pushTokenFingerprint } from '../../src/modules/notifications/mobile-push.crypto.js';
import { config, parseConfig } from '../../src/core/config.js';
const alice='11111111-1111-4111-8111-111111111111',bob='22222222-2222-4222-8222-222222222222';
const token='ExpoPushToken[testtoken0123456789]';
const device={expoPushToken:token,platform:'ios' as const,locale:'tr' as const,timezone:'Europe/Istanbul',clientRevision:1};
beforeAll(async()=>{
  const [database]=await sql`SELECT current_database() AS name`;
  if(database.name!=='quizball_push_test_20261007') throw new Error('Refusing a non-isolated push test database');
  // Vanilla CI PostgreSQL has no Supabase client roles. Create only those
  // inert roles after the isolated-database guard, before testing the revokes.
  await sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  END $$;`);
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY,is_ai boolean DEFAULT false,is_seed boolean DEFAULT false,
    is_banned boolean DEFAULT false,is_deleted boolean DEFAULT false,deleted_at timestamptz,pending_deletion_at timestamptz,
    partner_slug text,role text DEFAULT 'user');
    CREATE TABLE IF NOT EXISTS daily_challenge_configs(is_active boolean);
    CREATE TABLE IF NOT EXISTS daily_challenge_completions(user_id uuid,challenge_day date);
    CREATE TABLE IF NOT EXISTS daily_challenge_reminders(user_id uuid,status text,sent_at timestamptz);`);
  // This database is disposable and was created solely for this test suite.
  // Rebuild just the named test tables so each run exercises the exact migration.
  await sql.unsafe('DROP TABLE IF EXISTS mobile_push_jobs,mobile_push_events,mobile_push_campaigns,mobile_push_consent_log,mobile_push_preferences,mobile_push_devices,mobile_push_provider_state CASCADE');
  await sql.unsafe(await readFile(new URL('../../supabase/migrations/20261007080112_mobile_push_delivery.sql',import.meta.url),'utf8'));
});
beforeEach(async()=>{
  await sql.unsafe(`TRUNCATE mobile_push_jobs,mobile_push_events,mobile_push_campaigns,mobile_push_consent_log,
    mobile_push_preferences,mobile_push_devices,mobile_push_provider_state,users,daily_challenge_configs,daily_challenge_completions,daily_challenge_reminders CASCADE`);
  await sql`INSERT INTO users(id) VALUES(${alice}),(${bob})`;
});
afterAll(async()=>{await sql.end({timeout:2});});

it('registers atomically, encrypts tokens, and defaults marketing consent off',async()=>{
  await Promise.all(Array.from({length:4},()=>repo.register(alice,device)));
  const rows=await sql`SELECT * FROM mobile_push_devices`;
  expect(rows).toHaveLength(1);expect(rows[0].token_encrypted).not.toContain(token);
  expect(decryptPushToken(rows[0].token_encrypted)).toBe(token);
  expect(await repo.getPreferences(alice)).toEqual({matchInvitesEnabled:false,dailyRemindersEnabled:false,newGamesEnabled:false,dailyReminderHour:19,timezone:'Europe/Istanbul'});
});
it('caps each user at five active tokens even with concurrent registration',async()=>{
  const results=await Promise.allSettled(Array.from({length:9},(_,i)=>repo.register(alice,{...device,expoPushToken:`ExpoPushToken[testdevice0000000${i}]`})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(5);
  const [count]=await sql`SELECT count(*)::int AS n FROM mobile_push_devices WHERE active`;expect(count.n).toBe(5);
});
it('A → B → A device reassignment invalidates old jobs and stale receipt disable',async()=>{
  await repo.register(alice,device);await repo.queueTest(alice);
  const old=await repo.claim();expect(old).not.toBeNull();
  await repo.register(bob,{...device,clientRevision:2});await repo.register(alice,{...device,clientRevision:3});
  expect(await repo.payload(old!)).toBeNull();await repo.disable(old!);
  const [row]=await sql`SELECT active,generation,user_id FROM mobile_push_devices`;
  expect(row.active).toBe(true);expect(Number(row.generation)).toBe(3);expect(row.user_id).toBe(alice);
});
it('unregister affects only its owner; opt-out cancels pending marketing and logs consent',async()=>{
  await repo.register(alice,device);await repo.unregister(bob,{expoPushToken:token,platform:'ios',clientRevision:2});
  const [row]=await sql`SELECT active FROM mobile_push_devices`;expect(row.active).toBe(true);
  await repo.updatePreferences(alice,{newGamesEnabled:true});
  await repo.queueCampaign(alice,{campaignId:'33333333-3333-4333-8333-333333333333',title:{en:'New game',ka:'თამაში',es:'Juego',tr:'Oyun'},body:{en:'Play',ka:'ითამაშე',es:'Juega',tr:'Oyna'},route:'/(tabs)',confirmSend:true});
  const job=await repo.claim();expect(await repo.payload(job!)).not.toBeNull();
  await repo.updatePreferences(alice,{newGamesEnabled:false});expect(await repo.payload(job!)).toBeNull();
  const jobs=await sql`SELECT status FROM mobile_push_jobs`;expect(jobs[0].status).toBe('cancelled');
  const consent=await sql`SELECT choices FROM mobile_push_consent_log ORDER BY id`;expect(consent).toHaveLength(2);
});
it('queues reminders at hour 23, with one user event per day and fan-out per device',async()=>{
  const [zone]=await sql`SELECT name FROM pg_timezone_names WHERE extract(hour FROM now() AT TIME ZONE name)=23 LIMIT 1`;
  expect(zone).toBeDefined();
  await repo.register(alice,{...device,timezone:zone.name});
  await repo.register(alice,{...device,timezone:zone.name,expoPushToken:'ExpoPushToken[testseconddevice000]'});
  await repo.updatePreferences(alice,{dailyRemindersEnabled:true,dailyReminderHour:23});
  await sql`INSERT INTO daily_challenge_configs VALUES(true)`;
  await Promise.all([repo.queueReminders(),repo.queueReminders()]);
  const events=await sql`SELECT * FROM mobile_push_events`;const jobs=await sql`SELECT * FROM mobile_push_jobs`;
  expect(events).toHaveLength(1);expect(jobs).toHaveLength(2);
});
it('suppresses played-day reminders and recent email reminders',async()=>{
  const [zone]=await sql`SELECT name,extract(hour FROM now() AT TIME ZONE name)::int AS hour FROM pg_timezone_names LIMIT 1`;
  await repo.register(alice,{...device,timezone:zone.name});
  await repo.updatePreferences(alice,{dailyRemindersEnabled:true,dailyReminderHour:zone.hour});
  await sql`INSERT INTO daily_challenge_configs VALUES(true)`;
  await sql`INSERT INTO daily_challenge_completions VALUES(${alice},(now() AT TIME ZONE 'UTC')::date)`;
  await repo.queueReminders();expect(await sql`SELECT * FROM mobile_push_events`).toHaveLength(0);
  await sql`DELETE FROM daily_challenge_completions`;
  await sql`INSERT INTO daily_challenge_reminders VALUES(${alice},'sent',now())`;
  await repo.queueReminders();expect(await sql`SELECT * FROM mobile_push_events`).toHaveLength(0);
});
it('polls ticket receipts after message TTL and fences stale lease settlements',async()=>{
  await repo.register(alice,device);await repo.queueTest(alice);
  const job=await repo.claim();await repo.settle(job!,'ticketed',null,'ticket-123',0);
  await sql`UPDATE mobile_push_jobs SET created_at=now()-interval '25 hours'`;
  await sql`UPDATE mobile_push_events SET expires_at=now()-interval '1 second'`;
  await repo.maintain();const receipt=await repo.claim(true);expect(receipt?.ticket_id).toBe('ticket-123');
  await repo.settle(job!,'failed','STALE');
  const [row]=await sql`SELECT status FROM mobile_push_jobs`;expect(row.status).toBe('ticketed');
  await repo.settle(receipt!,'provider_accepted');
});
it('locks down all seven tables from anonymous/authenticated client roles',async()=>{
  const rows=await sql`SELECT c.relname,c.relrowsecurity,
    has_table_privilege('anon',c.oid,'SELECT') AS anon_read,has_table_privilege('authenticated',c.oid,'SELECT') AS member_read
    FROM pg_class c WHERE c.relname LIKE 'mobile_push_%' AND c.relkind='r'`;
  expect(rows).toHaveLength(7);for(const r of rows){expect(r.relrowsecurity).toBe(true);expect(r.anon_read).toBe(false);expect(r.member_read).toBe(false);}
});
it('does not silently change reminder timezone when another device registers',async()=>{
  await repo.register(alice,device);
  await repo.updatePreferences(alice,{timezone:'Asia/Tbilisi',dailyRemindersEnabled:true});
  const [before]=await sql`SELECT consent_epoch FROM mobile_push_preferences`;
  await repo.register(alice,{...device,timezone:'America/New_York',clientRevision:2});
  expect((await repo.getPreferences(alice)).timezone).toBe('Asia/Tbilisi');
  const [after]=await sql`SELECT consent_epoch FROM mobile_push_preferences`;expect(after.consent_epoch).toBe(before.consent_epoch);
});
it('campaign preview reports daily-capped users and retries do not duplicate a campaign',async()=>{
  await repo.register(alice,device);await repo.updatePreferences(alice,{newGamesEnabled:true});
  expect(await repo.previewCampaign()).toEqual({users:1,devices:1,alreadyCapped:0});
  const campaign={campaignId:'33333333-3333-4333-8333-333333333333',title:{en:'Game',ka:'თამაში',es:'Juego',tr:'Oyun'},body:{en:'Play',ka:'ითამაშე',es:'Juega',tr:'Oyna'},route:'/(tabs)' as const,confirmSend:true as const};
  expect(await repo.queueCampaign(alice,campaign)).toEqual({queued:1,duplicate:false});
  expect(await repo.queueCampaign(alice,campaign)).toEqual({queued:0,duplicate:true});
  expect(await repo.previewCampaign()).toEqual({users:0,devices:0,alreadyCapped:1});
  expect(await repo.queueCampaign(alice,{...campaign,campaignId:'44444444-4444-4444-8444-444444444444'})).toEqual({queued:0,duplicate:false});
});
it('shares provider backoff, pins fingerprint identity, and versions encryption without changing token identity',async()=>{
  await repo.register(alice,device);await repo.backoffProvider('HTTP_429',120);
  expect(await repo.providerBlocked()).toBe(true);
  await repo.ensureProviderKey();expect(await repo.providerBlocked()).toBe(true);
  const original=config.PUSH_TOKEN_ENCRYPTION_KEY, fingerprintKey=config.PUSH_TOKEN_FINGERPRINT_KEY;
  const old=encryptPushToken(token), fingerprint=pushTokenFingerprint(token);
  try {
    config.PUSH_TOKEN_ENCRYPTION_KEY_ID='v2';config.PUSH_TOKEN_ENCRYPTION_KEY='c'.repeat(64);
    config.PUSH_TOKEN_DECRYPTION_KEYS=JSON.stringify({v1:original});
    expect(decryptPushToken(old)).toBe(token);expect(decryptPushToken(encryptPushToken(token))).toBe(token);
    expect(pushTokenFingerprint(token)).toBe(fingerprint);
    config.PUSH_TOKEN_FINGERPRINT_KEY='d'.repeat(64);await expect(repo.ensureProviderKey()).rejects.toThrow('fingerprint key changed');
  } finally { config.PUSH_TOKEN_ENCRYPTION_KEY_ID='v1';config.PUSH_TOKEN_ENCRYPTION_KEY=original;config.PUSH_TOKEN_DECRYPTION_KEYS=undefined;config.PUSH_TOKEN_FINGERPRINT_KEY=fingerprintKey; }
  expect(()=>parseConfig({...process.env,PUSH_TOKEN_ENCRYPTION_KEY:undefined})).toThrow('requires encryption');
  expect(()=>parseConfig({...process.env,PUSH_TEST_USER_IDS:'not-a-uuid'})).toThrow('UUIDs');
});
it('short-lived test delivery is prioritised over campaign backlog',async()=>{
  await repo.register(alice,device);await repo.updatePreferences(alice,{newGamesEnabled:true});
  await repo.queueCampaign(alice,{campaignId:'33333333-3333-4333-8333-333333333333',title:{en:'New',ka:'ახალი',es:'Nuevo',tr:'Yeni'},body:{en:'Play',ka:'ითამაშე',es:'Juega',tr:'Oyna'},route:'/(tabs)',confirmSend:true});
  await repo.queueTest(alice);const job=await repo.claim();expect((await repo.payload(job!))?.category).toBe('test');
});
it('stale leases cannot disable the same device generation; oversized campaign transaction rolls back',async()=>{
  await repo.register(alice,device);await repo.queueTest(alice);const old=await repo.claim();
  await sql`UPDATE mobile_push_jobs SET lease_until=now()-interval '1 second'`;await repo.maintain();
  await sql`UPDATE mobile_push_jobs SET next_attempt_at=now()`;const reclaimed=await repo.claim();
  await repo.disable(old!);let [row]=await sql`SELECT active FROM mobile_push_devices`;expect(row.active).toBe(true);
  await repo.disable(reclaimed!);[row]=await sql`SELECT active FROM mobile_push_devices`;expect(row.active).toBe(false);
  await repo.register(alice,{...device,clientRevision:2});await repo.register(alice,{...device,expoPushToken:'ExpoPushToken[anotherdevice0000000]'});await repo.updatePreferences(alice,{newGamesEnabled:true});
  const max=config.PUSH_CAMPAIGN_MAX_DEVICES;config.PUSH_CAMPAIGN_MAX_DEVICES=1;
  try {await expect(repo.queueCampaign(alice,{campaignId:'33333333-3333-4333-8333-333333333333',title:{en:'New',ka:'ახალი',es:'Nuevo',tr:'Yeni'},body:{en:'Play',ka:'ითამაშე',es:'Juega',tr:'Oyna'},route:'/(tabs)',confirmSend:true})).rejects.toThrow('exceeds');}
  finally{config.PUSH_CAMPAIGN_MAX_DEVICES=max;}
  expect(await sql`SELECT * FROM mobile_push_campaigns`).toHaveLength(0);
  expect(await sql`SELECT * FROM mobile_push_events WHERE category='new_games'`).toHaveLength(0);
});
it('staging reminder queue only creates events for explicit test-account allowlist',async()=>{
  const [zone]=await sql`SELECT name,extract(hour FROM now() AT TIME ZONE name)::int AS hour FROM pg_timezone_names LIMIT 1`;
  for(const id of [alice,bob]) {await repo.register(id,{...device,timezone:zone.name,expoPushToken:`ExpoPushToken[device${id.replaceAll('-','')}]`});await repo.updatePreferences(id,{dailyRemindersEnabled:true,dailyReminderHour:zone.hour});}
  await sql`INSERT INTO daily_challenge_configs VALUES(true)`;await repo.queueReminders([]);expect(await sql`SELECT * FROM mobile_push_events`).toHaveLength(0);
  await repo.queueReminders([alice]);const events=await sql`SELECT user_id FROM mobile_push_events`;expect(events).toEqual([{user_id:alice}]);
});
it('logout fences a delayed registration even when unregister reaches the server first',async()=>{
  await repo.unregister(alice,{expoPushToken:token,platform:'ios',clientRevision:2});
  expect(await repo.register(alice,device)).toBe(false);
  let [row]=await sql`SELECT active,client_revision FROM mobile_push_devices`;
  expect(row.active).toBe(false);expect(Number(row.client_revision)).toBe(2);
  expect(await repo.register(alice,{...device,clientRevision:3})).toBe(true);
  await repo.unregister(alice,{expoPushToken:token,platform:'ios',clientRevision:2});
  [row]=await sql`SELECT active,client_revision FROM mobile_push_devices`;
  expect(row.active).toBe(true);expect(Number(row.client_revision)).toBe(3);
});
