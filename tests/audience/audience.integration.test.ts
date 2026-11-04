import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
const { audienceRepo } = await import('../../src/modules/audience/audience.repo.js');

const url = process.env.AUDIENCE_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:5432\/quizball_audience_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local audience test database required');

const RUN_TABLES = ['buscaminas_runs', 'minuto_runs', 'guess_the_goal_sessions', 'tenable_runs', 'shared_player_runs', 'ultimo_runs',
  'pistas_runs', 'name_chain_runs', 'football_race_runs', 'codenames_runs', 'dato_falso_runs', 'conexiones_runs', 'darts501_runs', 'grid_daily_runs'];
const ROUND_TABLES = ['squad_spin_rounds', 'trivia_mines_rounds', 'free_kicks_rounds', 'road_to_goal_rounds'];

// Only the columns audience.activity reads; the real migration is applied on top.
const SCHEMA = `
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), is_ai boolean NOT NULL DEFAULT false, is_seed boolean NOT NULL DEFAULT false,
    is_deleted boolean NOT NULL DEFAULT false, is_guest boolean NOT NULL DEFAULT false, deleted_at timestamptz, partner_slug text,
    role text NOT NULL DEFAULT 'user', country text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE user_identities (user_id uuid, provider text, subject text);
  CREATE TABLE user_signup_attribution (user_id uuid, platform text, recorded_at timestamptz DEFAULT now());
  CREATE TABLE guest_journeys (guest_id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), guest_user_id uuid, country text, linked_user_id uuid);
  CREATE TABLE matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mode text, game_variant text, is_dev boolean NOT NULL DEFAULT false, started_at timestamptz);
  CREATE TABLE match_players (match_id uuid, user_id uuid);
  CREATE TABLE football_grid_participants (match_id uuid, user_id uuid, created_at timestamptz);
  CREATE TABLE daily_challenge_completions (user_id uuid, challenge_type text, completed_at timestamptz);
  CREATE TABLE guest_daily_completions (guest_id uuid, challenge_type text, created_at timestamptz);
  CREATE TABLE wl_tournaments (id uuid PRIMARY KEY, is_test boolean NOT NULL DEFAULT false);
  CREATE TABLE wl_answers (user_id uuid, tournament_id uuid, game_index int NOT NULL DEFAULT 0, created_at timestamptz);
  CREATE TABLE duel_matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game text, started_at timestamptz);
  CREATE TABLE duel_participants (match_id uuid, user_id uuid);
  CREATE TABLE room_matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game text, started_at timestamptz);
  CREATE TABLE room_seats (match_id uuid, user_id uuid, admitted boolean NOT NULL DEFAULT true);
  ${ROUND_TABLES.map((t) => `CREATE TABLE ${t} (user_id uuid, created_at timestamptz);`).join('\n')}
  ${RUN_TABLES.map((t) => `CREATE TABLE ${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, guest_id uuid, created_at timestamptz);`).join('\n')}
`;

const DAY = '2026-11-03';
const AT = `${DAY}T10:00:00Z`;

describe.skipIf(!url)('audience player days (real Postgres)', () => {
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 4, onnotice: () => undefined });
    await db.sql.unsafe('DROP SCHEMA IF EXISTS audience CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await db.sql.unsafe(SCHEMA);
    await db.sql.unsafe(readFileSync(new URL('../../supabase/migrations/20261104120000_audience_player_days.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { await db.sql.end(); });
  beforeEach(async () => {
    const tables = ['users', 'user_identities', 'user_signup_attribution', 'guest_journeys', 'matches', 'match_players', 'football_grid_participants',
      'daily_challenge_completions', 'guest_daily_completions', 'wl_tournaments', 'wl_answers', 'duel_matches', 'duel_participants',
      'room_matches', 'room_seats', ...ROUND_TABLES, ...RUN_TABLES, 'audience.player_days', 'audience.refresh_state',
      'audience.ident_first_day', 'audience.guest_accounts'];
    await db.sql.unsafe(`TRUNCATE ${tables.join(', ')}`);
  });

  const user = async (o: Partial<{ is_ai: boolean; is_guest: boolean; role: string; partner_slug: string; country: string; created_at: string }> = {}) => {
    const [u] = await db.sql`INSERT INTO users (is_ai, is_guest, role, partner_slug, country, created_at)
      VALUES (${o.is_ai ?? false}, ${o.is_guest ?? false}, ${o.role ?? 'user'}, ${o.partner_slug ?? null}, ${o.country ?? null}, ${o.created_at ?? AT}) RETURNING id`;
    return u.id as string;
  };
  const match = async (variant: string, mode: string, players: string[], at = AT, isDev = false) => {
    const [m] = await db.sql`INSERT INTO matches (mode, game_variant, is_dev, started_at) VALUES (${mode}, ${variant}, ${isDev}, ${at}) RETURNING id`;
    for (const p of players) await db.sql`INSERT INTO match_players (match_id, user_id) VALUES (${m.id}, ${p})`;
    return m.id as string;
  };
  const run = (table: string, userId: string | null, guestId: string | null, at = AT) =>
    db.sql.unsafe(`INSERT INTO ${table} (user_id, guest_id, created_at) VALUES ($1, $2, $3)`, [userId, guestId, at]);
  const rows = () => db.sql<{ ident: string; kind: string; mode: string; plays: number }[]>`
    SELECT ident, kind, mode, plays FROM audience.player_days ORDER BY ident, mode`;

  it('counts one person across modes and the guest account and browser guest as one guest', async () => {
    const member = await user({ country: 'GE' });
    await match('ranked_sim', 'ranked', [member]);
    await run('tenable_runs', member, null);
    const guestId = randomUUID();
    const guestAccount = await user({ is_guest: true });
    await db.sql`INSERT INTO user_identities (user_id, provider, subject) VALUES (${guestAccount}, 'guest', ${guestId})`;
    await match('auction', 'auction', [guestAccount]);
    await run('buscaminas_runs', null, guestId);
    await audienceRepo.refreshDays(DAY, DAY);
    expect(await rows()).toEqual([
      { ident: `g:${guestId}`, kind: 'guest', mode: 'auction', plays: 1 },
      { ident: `g:${guestId}`, kind: 'guest', mode: 'buscaminas', plays: 1 },
      { ident: `u:${member}`, kind: 'registered', mode: 'ranked', plays: 1 },
      { ident: `u:${member}`, kind: 'registered', mode: 'tenable', plays: 1 },
    ]);
    const s = await audienceRepo.summary({ from: DAY, to: DAY });
    expect([s.active, s.registered, s.guests]).toEqual([2, 1, 1]);
  });

  it('keeps a guest account on its guest id after guest cleanup deletes the identity', async () => {
    const guestId = randomUUID();
    const guestAccount = await user({ is_guest: true });
    await db.sql`INSERT INTO user_identities (user_id, provider, subject) VALUES (${guestAccount}, 'guest', ${guestId})`;
    await match('auction', 'auction', [guestAccount], '2026-11-03T10:00:00Z');
    await match('auction', 'auction', [guestAccount], '2026-11-01T10:00:00Z');
    await audienceRepo.refreshDays('2026-11-03', '2026-11-03');
    await db.sql`DELETE FROM user_identities`;
    await audienceRepo.refreshDays('2026-11-01', '2026-11-01');
    expect((await db.sql`SELECT DISTINCT ident FROM audience.player_days`).map((r) => r.ident)).toEqual([`g:${guestId}`]);
    expect((await audienceRepo.summary({ from: '2026-11-01', to: '2026-11-03' })).active).toBe(1);
  });

  it('resolves a guest account through guest_journeys once its guest identity was retired', async () => {
    const guestId = randomUUID();
    const guestAccount = await user({ is_guest: true });
    await db.sql`INSERT INTO guest_journeys (guest_id, guest_user_id) VALUES (${guestId}, ${guestAccount})`;
    await match('football_grid', 'friendly', [guestAccount]);
    await audienceRepo.refreshDays(DAY, DAY);
    expect((await rows()).map((r) => r.ident)).toEqual([`g:${guestId}`]);
  });

  it('counts a guest who signed up as the member, also when the link appears after the refresh', async () => {
    const member = await user();
    const guestId = randomUUID();
    await run('minuto_runs', null, guestId);
    await match('ranked_sim', 'ranked', [member]);
    await audienceRepo.refreshDays(DAY, DAY);
    expect((await audienceRepo.summary({ from: DAY, to: DAY })).active).toBe(2);
    await db.sql`INSERT INTO guest_journeys (guest_id, linked_user_id) VALUES (${guestId}, ${member})`;
    const s = await audienceRepo.summary({ from: DAY, to: DAY });
    expect([s.active, s.registered, s.guests]).toEqual([1, 1, 0]);
  });

  it('never promotes a guest to an ineligible member and drops members deleted after the refresh', async () => {
    const admin = await user({ role: 'admin' });
    const member = await user();
    const guestId = randomUUID();
    await run('minuto_runs', null, guestId);
    await match('ranked_sim', 'ranked', [member]);
    await audienceRepo.refreshDays(DAY, DAY);
    await db.sql`INSERT INTO guest_journeys (guest_id, linked_user_id) VALUES (${guestId}, ${admin})`;
    let s = await audienceRepo.summary({ from: DAY, to: DAY });
    expect([s.active, s.registered, s.guests]).toEqual([1, 1, 0]);
    await db.sql`UPDATE users SET is_deleted = true WHERE id = ${member}`;
    s = await audienceRepo.summary({ from: DAY, to: DAY });
    expect([s.active, s.registered, s.guests]).toEqual([0, 0, 0]);
  });

  it('moves a first-seen day later when a correction removes the earliest play', async () => {
    const p = await user();
    const early = await match('ranked_sim', 'ranked', [p], '2026-11-01T10:00:00Z');
    await match('ranked_sim', 'ranked', [p], AT);
    await audienceRepo.refreshDays('2026-11-01', '2026-11-03');
    expect((await audienceRepo.summary({ from: DAY, to: DAY })).returning).toBe(1);
    await db.sql`UPDATE matches SET is_dev = true WHERE id = ${early}`;
    await audienceRepo.refreshDays('2026-11-01', '2026-11-01');
    const s = await audienceRepo.summary({ from: DAY, to: DAY });
    expect([s.new_players, s.returning]).toEqual([1, 0]);
  });

  it('leaves out a guest whose linked account is no longer eligible', async () => {
    const member = await user();
    const guestId = randomUUID();
    await run('minuto_runs', null, guestId);
    await db.sql`INSERT INTO guest_journeys (guest_id, linked_user_id) VALUES (${guestId}, ${member})`;
    await audienceRepo.refreshDays(DAY, DAY);
    expect((await audienceRepo.summary({ from: DAY, to: DAY })).registered).toBe(1);
    await db.sql`UPDATE users SET role = 'admin' WHERE id = ${member}`;
    expect((await audienceRepo.summary({ from: DAY, to: DAY })).active).toBe(0);
  });

  it('counts first-time players from first-seen days, including guest days before signup', async () => {
    const member = await user({ created_at: '2026-11-03T09:00:00Z' });
    const guestId = randomUUID();
    await run('tenable_runs', null, guestId, '2026-11-01T10:00:00Z');
    await db.sql`INSERT INTO guest_journeys (guest_id, linked_user_id) VALUES (${guestId}, ${member})`;
    await run('tenable_runs', member, null, '2026-11-03T10:00:00Z');
    const fresh = await user();
    await run('pistas_runs', fresh, null, '2026-11-03T11:00:00Z');
    await audienceRepo.refreshDays('2026-11-01', '2026-11-03');
    const s = await audienceRepo.summary({ from: DAY, to: DAY });
    expect([s.active, s.new_players, s.returning]).toEqual([2, 1, 1]);
    const n = await audienceRepo.newRegistered({ from: DAY, to: DAY });
    expect([n.total, n.played]).toEqual([2, 2]);
  });

  it('counts a late-linked new account as having played, without a refresh', async () => {
    const member = await user({ created_at: AT });
    const guestId = randomUUID();
    await run('minuto_runs', null, guestId);
    await audienceRepo.refreshDays(DAY, DAY);
    await db.sql`INSERT INTO guest_journeys (guest_id, linked_user_id) VALUES (${guestId}, ${member})`;
    const n = await audienceRepo.newRegistered({ from: DAY, to: DAY });
    expect([n.total, n.played]).toEqual([1, 1]);
  });

  it('treats a day refreshed before it ended as not final, and a refresh after it ended as final', async () => {
    await db.sql`INSERT INTO audience.refresh_state (day, refreshed_at, complete, rows) VALUES ('2026-11-01', '2026-11-01T08:00:00Z', false, 0)`;
    await audienceRepo.refreshDays('2026-11-02', '2026-11-02');
    expect(await audienceRepo.incompleteDays('2026-11-01', '2026-11-02', 5)).toEqual(['2026-11-01']);
    const cov = await audienceRepo.coverage('2026-11-01', '2026-11-02');
    expect([cov.first_complete_day, cov.incomplete_days]).toEqual(['2026-11-02', 1]);
  });

  it('skips a day another replica refreshed in the last 5 minutes (-2)', async () => {
    await audienceRepo.refreshDays(DAY, DAY);
    expect(await audienceRepo.refreshDays(DAY, DAY, false)).toBe(-2);
  });

  it('counts a Weekend League game once, not once per answer', async () => {
    const p = await user();
    const t = randomUUID();
    await db.sql`INSERT INTO wl_tournaments (id) VALUES (${t})`;
    for (const q of [0, 1, 2]) await db.sql`INSERT INTO wl_answers (user_id, tournament_id, game_index, created_at) VALUES (${p}, ${t}, 0, ${`2026-11-03T10:0${q}:00Z`})`;
    await db.sql`INSERT INTO wl_answers (user_id, tournament_id, game_index, created_at) VALUES (${p}, ${t}, 1, ${AT})`;
    await audienceRepo.refreshDays(DAY, DAY);
    expect(await rows()).toEqual([{ ident: `u:${p}`, kind: 'registered', mode: 'weekend_league', plays: 2 }]);
  });

  it('counts a Weekend League game that crosses Georgia midnight once, on the day of its first answer', async () => {
    const p = await user();
    const t = randomUUID();
    await db.sql`INSERT INTO wl_tournaments (id) VALUES (${t})`;
    for (const at of ['2026-11-02T19:59:00Z', '2026-11-02T20:01:00Z']) {
      await db.sql`INSERT INTO wl_answers (user_id, tournament_id, game_index, created_at) VALUES (${p}, ${t}, 0, ${at})`;
    }
    await audienceRepo.refreshDays('2026-11-02', '2026-11-02');
    await audienceRepo.refreshDays(DAY, DAY);
    const days = await db.sql`SELECT to_char(day, 'YYYY-MM-DD') AS day, plays FROM audience.player_days`;
    expect(days.map((d) => `${d.day}:${d.plays}`)).toEqual(['2026-11-02:1']);
  });

  it('counts a guest account with two guest identities as one guest, without duplicating plays', async () => {
    const guestAccount = await user({ is_guest: true });
    const [a, b] = [randomUUID(), randomUUID()].sort();
    await db.sql`INSERT INTO user_identities (user_id, provider, subject) VALUES (${guestAccount}, 'guest', ${b}), (${guestAccount}, 'guest', ${a})`;
    await match('auction', 'auction', [guestAccount]);
    await audienceRepo.refreshDays(DAY, DAY);
    expect(await rows()).toEqual([{ ident: `g:${a}`, kind: 'guest', mode: 'auction', plays: 1 }]);
  });

  it('returns every day of the trend, zeros and not-yet-counted days included', async () => {
    await run('tenable_runs', await user(), null, '2026-11-03T10:00:00Z');
    await audienceRepo.refreshDays('2026-11-02', '2026-11-03');
    expect(await audienceRepo.trend({ from: '2026-11-01', to: '2026-11-03' })).toEqual([
      { day: '2026-11-01', active: 0, registered: 0, guests: 0, counted: false },
      { day: '2026-11-02', active: 0, registered: 0, guests: 0, counted: true },
      { day: '2026-11-03', active: 1, registered: 1, guests: 0, counted: true },
    ]);
  });

  it('counts Tic Tac Toe once although the grid roster is stored twice', async () => {
    const a = await user();
    const b = await user();
    const m = await match('football_grid', 'friendly', [a, b]);
    for (const p of [a, b]) await db.sql`INSERT INTO football_grid_participants (match_id, user_id, created_at) VALUES (${m}, ${p}, ${AT})`;
    await audienceRepo.refreshDays(DAY, DAY);
    expect(await audienceRepo.games({ from: DAY, to: DAY }, 5)).toEqual([{ mode: 'tic_tac_toe', players: 2, registered: 2, guests: 0, plays: 2 }]);
  });

  it('leaves out AI, admins, partner players, dev matches and test tournaments', async () => {
    const bot = await user({ is_ai: true });
    const admin = await user({ role: 'admin' });
    const partner = await user({ partner_slug: 'betsson' });
    const real = await user();
    await match('ranked_sim', 'ranked', [bot, admin, partner, real]);
    await match('ranked_sim', 'ranked', [await user()], AT, true);
    const t = randomUUID();
    await db.sql`INSERT INTO wl_tournaments (id, is_test) VALUES (${t}, true)`;
    await db.sql`INSERT INTO wl_answers (user_id, tournament_id, created_at) VALUES (${await user()}, ${t}, ${AT})`;
    await audienceRepo.refreshDays(DAY, DAY);
    expect((await rows()).map((r) => r.ident)).toEqual([`u:${real}`]);
  });

  it('assigns plays to Georgia days (UTC+4) and replaces a day atomically on refresh', async () => {
    const p = await user();
    await run('tenable_runs', p, null, '2026-11-03T19:59:59Z');
    await run('pistas_runs', p, null, '2026-11-03T20:00:00Z');
    await audienceRepo.refreshDays('2026-11-03', '2026-11-04');
    const days = await db.sql`SELECT to_char(day, 'YYYY-MM-DD') AS day, mode FROM audience.player_days ORDER BY day`;
    expect(days.map((d) => `${d.day} ${d.mode}`)).toEqual(['2026-11-03 tenable', '2026-11-04 pistas']);
    await db.sql`DELETE FROM tenable_runs`;
    await audienceRepo.refreshDays('2026-11-03', '2026-11-03');
    expect((await db.sql`SELECT count(*)::int AS n FROM audience.player_days WHERE day = '2026-11-03'`)[0].n).toBe(0);
    expect((await db.sql`SELECT rows FROM audience.refresh_state WHERE day = '2026-11-03'`)[0].rows).toBe(0);
  });

  it('lets one replica refresh: a non-waiting caller skips while the lock is held', async () => {
    const holder = postgres(url!, { max: 1, onnotice: () => undefined });
    try {
      await holder.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('audience.refresh_days'))`;
        expect(await audienceRepo.refreshDays(DAY, DAY, false)).toBe(-1);
      });
      expect(await audienceRepo.refreshDays(DAY, DAY, false)).toBe(0);
    } finally {
      await holder.end();
    }
  });

  it('reports countries per person and new accounts per country, signup-only countries included', async () => {
    await user({ country: 'FR', created_at: AT });
    const ge = await user({ country: 'ge', created_at: AT });
    const guestId = randomUUID();
    await db.sql`INSERT INTO guest_journeys (guest_id, country) VALUES (${guestId}, 'ES')`;
    await run('tenable_runs', ge, null);
    await run('tenable_runs', null, guestId);
    await audienceRepo.refreshDays(DAY, DAY);
    expect(await audienceRepo.countries({ from: DAY, to: DAY }, 10)).toEqual([
      { country: 'GE', active: 1, registered: 1, guests: 0, new_registered: 1 },
      { country: 'ES', active: 1, registered: 0, guests: 1, new_registered: 0 },
      { country: 'FR', active: 0, registered: 0, guests: 0, new_registered: 1 },
    ]);
    const fresh = await audienceRepo.newRegistered({ from: DAY, to: DAY });
    expect([fresh.total, fresh.played]).toEqual([2, 1]);
  });
});
