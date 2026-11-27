import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

// The overview's real SQL, executed by Postgres (the repo tests only render it).
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
const { adminStatsRepo } = await import('../../src/modules/admin-stats/admin-stats.repo.js');
const { adminStatsService } = await import('../../src/modules/admin-stats/admin-stats.service.js');

const url = process.env.ADMIN_STATS_TEST_DATABASE_URL;
if (url && !/^postgres(ql)?:\/\/[^@]+@127\.0\.0\.1:\d+\/quizball_admin_stats_[a-z0-9_]+$/.test(url)) {
  throw new Error('Isolated local database quizball_admin_stats_* on 127.0.0.1 required');
}

const RUN_TABLES = ['ultimo_runs', 'name_chain_runs', 'buscaminas_runs', 'minuto_runs', 'pistas_runs', 'conexiones_runs',
  'dato_falso_runs', 'codenames_runs', 'tenable_runs', 'football_race_runs', 'darts501_runs', 'draft_runs_budget',
  'draft_runs_classic', 'draft_runs_knowledge', 'draft_free_runs', 'grid_daily_runs', 'shared_player_runs'];
const ROUND_TABLES = ['squad_spin_rounds', 'trivia_mines_rounds', 'free_kicks_rounds', 'road_to_goal_rounds'];

// Only the columns the overview reads; partner_daily_stats comes from its real migration.
const SCHEMA = `
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DROP SCHEMA public CASCADE; CREATE SCHEMA public;
  CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), is_ai boolean NOT NULL DEFAULT false,
    is_seed boolean NOT NULL DEFAULT false, is_deleted boolean NOT NULL DEFAULT false, is_guest boolean NOT NULL DEFAULT false,
    country text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE guest_journeys (guest_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
    first_play_at timestamptz, linked_user_id uuid, country text);
  CREATE TABLE matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mode text, game_variant text,
    is_dev boolean NOT NULL DEFAULT false, started_at timestamptz);
  CREATE TABLE match_players (match_id uuid, user_id uuid);
  CREATE TABLE daily_challenge_completions (user_id uuid, completed_at timestamptz);
  CREATE TABLE guest_daily_completions (guest_id uuid, created_at timestamptz);
  CREATE TABLE guess_the_goal_sessions (user_id uuid, guest_id uuid, created_at timestamptz);
  CREATE TABLE wl_tournaments (id uuid PRIMARY KEY, is_test boolean NOT NULL DEFAULT false);
  CREATE TABLE wl_answers (user_id uuid, tournament_id uuid, game_index int NOT NULL DEFAULT 0, created_at timestamptz);
  CREATE TABLE duel_matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), started_at timestamptz);
  CREATE TABLE duel_participants (match_id uuid, user_id uuid);
  CREATE TABLE room_matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game text, started_at timestamptz);
  CREATE TABLE room_seats (match_id uuid, user_id uuid, admitted boolean NOT NULL DEFAULT true);
  ${ROUND_TABLES.map((t) => `CREATE TABLE ${t} (user_id uuid, created_at timestamptz);`).join('\n')}
  ${RUN_TABLES.map((t) => `CREATE TABLE ${t} (user_id uuid, guest_id uuid, created_at timestamptz);`).join('\n')}
`;

const tbilisiToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dayBefore = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!url)('admin-stats overview SQL (real Postgres)', () => {
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 2, onnotice: () => undefined });
    await db.sql.unsafe(SCHEMA);
    await db.sql.unsafe(readFileSync(new URL('../../supabase/migrations/20261126150000_partner_daily_stats.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { await db.sql.end(); });
  beforeEach(async () => {
    await db.sql.unsafe(`TRUNCATE users, guest_journeys, matches, match_players, partner_daily_stats, ${RUN_TABLES.join(', ')}`);
  });

  // "Now" and "a day ago" are always today and yesterday in Tbilisi, whatever the clock says.
  const seed = async () => {
    const [today, old] = await db.sql<{ id: string }[]>`
      INSERT INTO users (created_at) VALUES (now()), (now() - interval '40 days') RETURNING id`;
    const [m] = await db.sql<{ id: string }[]>`
      INSERT INTO matches (mode, game_variant, started_at) VALUES ('ranked', 'ranked_sim', now()) RETURNING id`;
    await db.sql`INSERT INTO match_players VALUES (${m!.id}, ${today!.id}), (${m!.id}, ${old!.id})`;
    await db.sql`INSERT INTO minuto_runs (user_id, created_at) VALUES (${old!.id}, now() - interval '1 day')`;
    await db.sql`INSERT INTO minuto_runs (user_id, created_at) VALUES (${old!.id}, now() - interval '35 days')`;
  };

  it('runs the DAU chart and signups over the last 30 Tbilisi days', async () => {
    await seed();
    const today = tbilisiToday();
    const dau = await adminStatsRepo.dauSeries(30);
    expect(dau.at(-1)).toEqual({ day: today, count: 2 });
    expect(dau.every((r) => r.day > dayBefore(today, 30))).toBe(true);
    expect(dau.find((r) => r.day === dayBefore(today, 1))?.count).toBe(1);
    expect(await adminStatsRepo.signupsPerDay(30)).toEqual([{ day: today, count: 1 }]);
    expect(await adminStatsRepo.actives()).toEqual({ dau: 2, wau: 2, mau: 2 });
  });

  it('serves the whole overview with Table Derby added', async () => {
    await seed();
    const today = tbilisiToday();
    await db.sql`
      INSERT INTO partner_daily_stats
        (partner, day, total_users, new_users, active_users, active_7d, active_30d, matches, source_at)
      VALUES ('table-derby', ${today}, 500, 4, 30, 120, 300, 55, now()),
             ('table-derby', ${dayBefore(today, 1)}, 496, 6, 40, 110, 290, 60, now())`;
    const value = await adminStatsService.analyticsOverview();
    expect(value.totals.totalUsers).toBe(2 + 500);
    expect(value.actives).toEqual({ dau: 32, wau: 122, mau: 302 });
    expect(value.dauSeries.at(-1)).toEqual({ day: today, count: 32 });
    expect(value.signupsPerDay).toEqual([{ day: dayBefore(today, 1), count: 6 }, { day: today, count: 5 }]);
    expect(value.breakdown?.tableDerby?.day).toBe(today);
    expect(value.gamesPerDay.find((g) => g.day === today)).toEqual({ day: today, mode: 'ranked', games: 1 });
  });
});
