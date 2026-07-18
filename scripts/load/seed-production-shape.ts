/* eslint-disable no-console */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import postgres from 'postgres';

const PROD_REF = 'lfbwhxvwubzeqkztghok';
const STAGING_REF = 'nsdfiprfmhdqhbfxfwpv';
const MARKER = 'quizball-prod-shape-v1';
const USER_EMAIL_LIKE = 'load-seed-%@example.invalid';
const LOBBY_NAME_LIKE = 'LOAD-SEED-%';
const LOCAL_CATEGORY_SLUG_LIKE = 'load-seed-category-%';
const LOCAL_CATEGORY_TARGET = 20;
const LOCAL_QUESTION_TARGET = 16_007;

// Snapshot from production metadata on 2026-07-18. These are counts only;
// production rows are never read or copied by this seeder.
const TARGETS = {
  users: 25_280,
  lobbies: 67_104,
  matches: 68_942,
  match_players: 112_033,
  match_questions: 894_527,
  match_answers: 1_477_584,
  match_goal_events: 165_368,
  ranked_profiles: 6_642,
  user_mode_match_stats: 26_556,
  ranked_rp_changes: 75_264,
} as const;

type ShapeTable = keyof typeof TARGETS;

interface Args {
  target: 'local' | 'staging';
  apply: boolean;
  reset: boolean;
  databaseUrl: string;
  reportPath: string;
}

interface TablePlan {
  current: number;
  existingSeed: number;
  baseline: number;
  target: number;
  desiredSeed: number;
}

function value(argv: string[], key: string): string | undefined {
  const exact = argv.indexOf(`--${key}`);
  if (exact >= 0) return argv[exact + 1]?.startsWith('--') ? 'true' : argv[exact + 1] ?? 'true';
  const prefix = `--${key}=`;
  return argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function parseArgs(argv: string[]): Args {
  const target = (value(argv, 'target') ?? 'local') as Args['target'];
  if (target !== 'local' && target !== 'staging') {
    throw new Error('--target must be local or staging. Production is never supported.');
  }
  const databaseUrl = value(argv, 'db') ?? process.env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL or --db is required.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    target,
    apply: value(argv, 'apply') === 'true',
    reset: value(argv, 'reset') === 'true',
    databaseUrl,
    reportPath: value(argv, 'report')
      ?? resolve(process.cwd(), 'scripts/load/distributed/reports', `seed-${target}-${stamp}.json`),
  };
}

function assertTargetSafe(args: Args): void {
  const parsed = new URL(args.databaseUrl);
  // Supavisor hosts are shared; the project ref is carried in the username
  // (`postgres.<project-ref>`), while direct connections carry it in the host.
  const blob = `${decodeURIComponent(parsed.username)}@${parsed.hostname}${parsed.pathname}`;
  if (blob.includes(PROD_REF)) throw new Error('PROD GUARD: production project reference detected.');
  if (args.target === 'staging' && !blob.includes(STAGING_REF)) {
    throw new Error('STAGING GUARD: database URL is not the QuizBall staging project.');
  }
  if (args.target === 'local') {
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    const nativeRegression = parsed.pathname === '/quizball_regression' && ['5432', ''].includes(parsed.port);
    const dockerSupabase = parsed.pathname === '/postgres' && parsed.port === '54322';
    if (!localHost || (!nativeRegression && !dockerSupabase)) {
      throw new Error(
        'LOCAL GUARD: use quizball_regression on local port 5432 or Docker Supabase postgres on local port 54322.'
      );
    }
  }
}

async function scalar(sql: postgres.Sql, query: string): Promise<number> {
  const rows = await sql.unsafe<{ value: number | string }[]>(query);
  return Number(rows[0]?.value ?? 0);
}

async function tablePlan(sql: postgres.Sql, table: ShapeTable): Promise<TablePlan> {
  const current = await scalar(sql, `SELECT count(*) AS value FROM public.${table}`);
  const seedPredicates: Record<ShapeTable, string> = {
    users: `email LIKE '${USER_EMAIL_LIKE}'`,
    lobbies: `display_name LIKE '${LOBBY_NAME_LIKE}'`,
    matches: `ranked_context->>'loadSeed' = '${MARKER}'`,
    match_players: `EXISTS (SELECT 1 FROM public.matches m WHERE m.id=match_players.match_id AND m.ranked_context->>'loadSeed'='${MARKER}')`,
    match_questions: `EXISTS (SELECT 1 FROM public.matches m WHERE m.id=match_questions.match_id AND m.ranked_context->>'loadSeed'='${MARKER}')`,
    match_answers: `EXISTS (SELECT 1 FROM public.matches m WHERE m.id=match_answers.match_id AND m.ranked_context->>'loadSeed'='${MARKER}')`,
    match_goal_events: `EXISTS (SELECT 1 FROM public.matches m WHERE m.id=match_goal_events.match_id AND m.ranked_context->>'loadSeed'='${MARKER}')`,
    ranked_profiles: `EXISTS (SELECT 1 FROM public.users u WHERE u.id=ranked_profiles.user_id AND u.email LIKE '${USER_EMAIL_LIKE}')`,
    user_mode_match_stats: `EXISTS (SELECT 1 FROM public.users u WHERE u.id=user_mode_match_stats.user_id AND u.email LIKE '${USER_EMAIL_LIKE}')`,
    ranked_rp_changes: `EXISTS (SELECT 1 FROM public.matches m WHERE m.id=ranked_rp_changes.match_id AND m.ranked_context->>'loadSeed'='${MARKER}')`,
  };
  const existingSeed = await scalar(
    sql,
    `SELECT count(*) AS value FROM public.${table} WHERE ${seedPredicates[table]}`
  );
  const baseline = current - existingSeed;
  return {
    current,
    existingSeed,
    baseline,
    target: TARGETS[table],
    desiredSeed: Math.max(0, TARGETS[table] - baseline),
  };
}

async function plans(sql: postgres.Sql): Promise<Record<ShapeTable, TablePlan>> {
  const entries: Array<readonly [ShapeTable, TablePlan]> = [];
  // Keep this sequential. Besides reducing observer traffic on a Micro staging
  // database, per-table progress makes a slow baseline query immediately
  // attributable instead of looking like a hung dry run.
  for (const table of Object.keys(TARGETS) as ShapeTable[]) {
    console.log(`  planning ${table}…`);
    entries.push([table, await tablePlan(sql, table)] as const);
  }
  return Object.fromEntries(entries) as Record<ShapeTable, TablePlan>;
}

async function resetSeed(sql: postgres.Sql): Promise<void> {
  console.log('Removing prior tagged synthetic rows…');
  await sql`DELETE FROM public.matches WHERE ranked_context->>'loadSeed' = ${MARKER}`;
  await sql`DELETE FROM public.lobbies WHERE display_name LIKE ${LOBBY_NAME_LIKE}`;
  await sql`DELETE FROM public.users WHERE email LIKE ${USER_EMAIL_LIKE}`;
  await sql`
    DELETE FROM public.questions
    WHERE category_id IN (
      SELECT id FROM public.categories WHERE slug LIKE ${LOCAL_CATEGORY_SLUG_LIKE}
    )
  `;
  await sql`DELETE FROM public.categories WHERE slug LIKE ${LOCAL_CATEGORY_SLUG_LIKE}`;
}

async function batches(
  label: string,
  total: number,
  batchSize: number,
  insert: (start: number, end: number) => Promise<unknown>
): Promise<void> {
  if (total <= 0) return;
  for (let start = 1; start <= total; start += batchSize) {
    const end = Math.min(total, start + batchSize - 1);
    await insert(start, end);
    console.log(`  ${label}: ${end.toLocaleString()}/${total.toLocaleString()}`);
  }
}

function seedUserId(seqSql: string): string {
  return `md5('${MARKER}:user:' || (${seqSql})::text)::uuid`;
}

function seedLobbyId(seqSql: string): string {
  return `md5('${MARKER}:lobby:' || (${seqSql})::text)::uuid`;
}

function seedMatchId(seqSql: string): string {
  return `md5('${MARKER}:match:' || (${seqSql})::text)::uuid`;
}

async function localContentPlan(sql: postgres.Sql): Promise<{
  categories: TablePlan;
  questions: TablePlan;
}> {
  const categories = await scalar(sql, 'SELECT count(*) AS value FROM public.categories');
  const seedCategories = await scalar(
    sql,
    `SELECT count(*) AS value FROM public.categories WHERE slug LIKE '${LOCAL_CATEGORY_SLUG_LIKE}'`
  );
  const questions = await scalar(sql, 'SELECT count(*) AS value FROM public.questions');
  const seedQuestions = await scalar(sql, `
    SELECT count(*) AS value
    FROM public.questions q
    JOIN public.categories c ON c.id=q.category_id
    WHERE c.slug LIKE '${LOCAL_CATEGORY_SLUG_LIKE}'
  `);
  const categoryBaseline = categories - seedCategories;
  const questionBaseline = questions - seedQuestions;
  return {
    categories: {
      current: categories,
      existingSeed: seedCategories,
      baseline: categoryBaseline,
      target: LOCAL_CATEGORY_TARGET,
      desiredSeed: Math.max(0, LOCAL_CATEGORY_TARGET - categoryBaseline),
    },
    questions: {
      current: questions,
      existingSeed: seedQuestions,
      baseline: questionBaseline,
      target: LOCAL_QUESTION_TARGET,
      desiredSeed: Math.max(0, LOCAL_QUESTION_TARGET - questionBaseline),
    },
  };
}

async function seedLocalContent(
  sql: postgres.Sql,
  plan: Awaited<ReturnType<typeof localContentPlan>>
): Promise<void> {
  const categories = plan.categories.desiredSeed;
  const questions = plan.questions.desiredSeed;
  if (categories < 2) {
    throw new Error('Local content seed requires room for at least two synthetic categories.');
  }
  await sql.unsafe(`
    INSERT INTO public.categories (id,slug,name,description,icon,is_active)
    SELECT md5('${MARKER}:category:'||g)::uuid,
           'load-seed-category-'||g,
           jsonb_build_object('en','Load Seed Category '||g,'ka','Load Seed Category '||g),
           jsonb_build_object('en','Synthetic local load-test category'),
           '⚽',true
    FROM generate_series(1,${categories}) g
    ON CONFLICT (id) DO NOTHING
  `);
  await sql.unsafe(`
    INSERT INTO public.featured_categories (category_id)
    SELECT md5('${MARKER}:category:'||g)::uuid
    FROM generate_series(1,${categories}) g
    ON CONFLICT (category_id) DO NOTHING
  `);
  await batches('local questions + payloads', questions, 10_000, async (start, end) => {
    await sql.unsafe(`
      WITH seeded AS (
        INSERT INTO public.questions (id,category_id,type,difficulty,status,prompt,explanation)
        SELECT md5('${MARKER}:question:'||g)::uuid,
               md5('${MARKER}:category:'||(((g-1)%${categories})+1))::uuid,
               CASE g%20 WHEN 0 THEN 'put_in_order' WHEN 1 THEN 'clue_chain'
                    WHEN 2 THEN 'countdown_list' ELSE 'mcq_single' END,
               (ARRAY['easy','medium','hard'])[1+(g%3)],'published',
               jsonb_build_object('en','Load seed question '||g,'ka','Load seed question '||g),
               jsonb_build_object('en','Synthetic explanation '||g)
        FROM generate_series(${start},${end}) g
        ON CONFLICT (id) DO UPDATE SET status='published'
        RETURNING id,type
      )
      INSERT INTO public.question_payloads (id,question_id,payload)
      SELECT md5('${MARKER}:payload:'||s.id::text)::uuid,s.id,
        CASE s.type
          WHEN 'mcq_single' THEN jsonb_build_object(
            'type','mcq_single','options',jsonb_build_array(
              jsonb_build_object('id','a','text',jsonb_build_object('en','A'),'is_correct',true),
              jsonb_build_object('id','b','text',jsonb_build_object('en','B'),'is_correct',false),
              jsonb_build_object('id','c','text',jsonb_build_object('en','C'),'is_correct',false),
              jsonb_build_object('id','d','text',jsonb_build_object('en','D'),'is_correct',false)))
          WHEN 'put_in_order' THEN jsonb_build_object(
            'type','put_in_order','prompt',jsonb_build_object('en','Put the items in order'),
            'direction','asc','items',jsonb_build_array(
              jsonb_build_object('id','first','label',jsonb_build_object('en','First'),'sort_value',1),
              jsonb_build_object('id','second','label',jsonb_build_object('en','Second'),'sort_value',2),
              jsonb_build_object('id','third','label',jsonb_build_object('en','Third'),'sort_value',3)))
          WHEN 'countdown_list' THEN jsonb_build_object(
            'type','countdown_list','prompt',jsonb_build_object('en','Name the items'),
            'answer_groups',jsonb_build_array(
              jsonb_build_object('id','one','display',jsonb_build_object('en','One'),'accepted_answers',jsonb_build_array('one')),
              jsonb_build_object('id','two','display',jsonb_build_object('en','Two'),'accepted_answers',jsonb_build_array('two')),
              jsonb_build_object('id','three','display',jsonb_build_object('en','Three'),'accepted_answers',jsonb_build_array('three'))))
          ELSE jsonb_build_object(
            'type','clue_chain','display_answer',jsonb_build_object('en','Answer'),
            'accepted_answers',jsonb_build_array('answer'),'clues',jsonb_build_array(
              jsonb_build_object('type','text','content',jsonb_build_object('en','Clue one')),
              jsonb_build_object('type','text','content',jsonb_build_object('en','Clue two')),
              jsonb_build_object('type','text','content',jsonb_build_object('en','Clue three'))))
        END
      FROM seeded s
      ON CONFLICT (question_id) DO UPDATE SET payload=EXCLUDED.payload
    `);
  });
  await sql`ANALYZE public.categories`;
  await sql`ANALYZE public.questions`;
  await sql`ANALYZE public.question_payloads`;
}

async function seed(sql: postgres.Sql, plan: Record<ShapeTable, TablePlan>): Promise<void> {
  const users = plan.users.desiredSeed;
  const lobbies = plan.lobbies.desiredSeed;
  const matches = plan.matches.desiredSeed;
  if (users < 2 || lobbies < 1 || matches < 1) {
    throw new Error('Production-shape seed requires at least two synthetic users, one lobby, and one match.');
  }

  const content = await sql<{ categories: number; questions: number }[]>`
    SELECT
      (SELECT count(*)::int FROM public.categories WHERE is_active=true) AS categories,
      (SELECT count(*)::int FROM public.questions WHERE status='published') AS questions
  `;
  if ((content[0]?.categories ?? 0) < 2 || (content[0]?.questions ?? 0) < 20) {
    throw new Error('Seed target needs at least two active categories and twenty published questions.');
  }

  await batches('users', users, 5_000, (start, end) => sql.unsafe(`
    INSERT INTO public.users
      (id,email,nickname,country,onboarding_complete,is_ai,is_seed,coins,tickets,total_xp)
    SELECT ${seedUserId('g')},
           'load-seed-'||g||'@example.invalid',
           'LoadSeed'||g,
           CASE g % 5 WHEN 0 THEN 'GE' WHEN 1 THEN 'US' WHEN 2 THEN 'GB' WHEN 3 THEN 'DE' ELSE 'BR' END,
           true,false,true,(g % 5000)::int,(g % 6)::int,(g * 17)::bigint
    FROM generate_series(${start},${end}) g
    ON CONFLICT (id) DO NOTHING
  `));

  await batches('lobbies', lobbies, 10_000, (start, end) => sql.unsafe(`
    INSERT INTO public.lobbies
      (id,invite_code,mode,host_user_id,status,created_at,updated_at,game_mode,is_public,display_name,ranked_context)
    SELECT ${seedLobbyId('g')},NULL,'ranked',
           ${seedUserId(`((g - 1) % ${users}) + 1`)},
           'closed',now() - ((g % 365)||' days')::interval,
           now() - ((g % 365)||' days')::interval,
           'ranked_sim',false,'LOAD-SEED-'||g,
           jsonb_build_object('loadSeed','${MARKER}')
    FROM generate_series(${start},${end}) g
    ON CONFLICT (id) DO NOTHING
  `));

  await batches('matches', matches, 10_000, (start, end) => sql.unsafe(`
    WITH cats AS (
      SELECT array_agg(id ORDER BY id) ids, count(*)::int n
      FROM public.categories WHERE is_active=true
    )
    INSERT INTO public.matches
      (id,lobby_id,mode,status,category_a_id,category_b_id,current_q_index,total_questions,
       started_at,ended_at,winner_user_id,updated_at,ranked_context,is_dev)
    SELECT ${seedMatchId('g')},${seedLobbyId(`((g - 1) % ${lobbies}) + 1`)},
           'ranked','completed',cats.ids[((g - 1) % cats.n)+1],NULL,10,10,
           now() - ((g % 365)||' days')::interval,
           now() - ((g % 365)||' days')::interval + interval '3 minutes',
           ${seedUserId(`(((g * 2) - 2) % ${users}) + 1`)},
           now() - ((g % 365)||' days')::interval + interval '3 minutes',
           jsonb_build_object('loadSeed','${MARKER}','synthetic',true),true
    FROM generate_series(${start},${end}) g CROSS JOIN cats
    ON CONFLICT (id) DO NOTHING
  `));

  const players = Math.min(plan.match_players.desiredSeed, matches * 2);
  await batches('match_players', players, 50_000, (start, end) => sql.unsafe(`
    INSERT INTO public.match_players
      (match_id,user_id,seat,total_points,correct_answers,avg_time_ms,goals,penalty_goals,placement)
    SELECT ${seedMatchId(`((g - 1) / 2) + 1`)},
           ${seedUserId(`(((((g - 1) / 2) * 2 + ((g - 1) % 2)) % ${users}) + 1)`)},
           (((g - 1) % 2) + 1)::smallint,(g % 900)::int,(g % 8)::int,
           (1000 + g % 7000)::int,(g % 6)::int,0,NULL
    FROM generate_series(${start},${end}) g
    ON CONFLICT DO NOTHING
  `));

  const questions = plan.match_questions.desiredSeed;
  await batches('match_questions', questions, 50_000, (start, end) => sql.unsafe(`
    WITH available AS (
      SELECT array_agg(id ORDER BY id) qids,array_agg(category_id ORDER BY id) cids,count(*)::int n
      FROM public.questions WHERE status='published'
    ), shaped AS (
      SELECT g,((g - 1) % ${matches}) + 1 AS match_seq,((g - 1) / ${matches})::int AS q_index
      FROM generate_series(${start},${end}) g
    )
    INSERT INTO public.match_questions
      (match_id,q_index,question_id,category_id,correct_index,shown_at,deadline_at,phase_kind)
    SELECT ${seedMatchId('s.match_seq')},s.q_index,
           a.qids[((s.match_seq + s.q_index - 1) % a.n)+1],
           a.cids[((s.match_seq + s.q_index - 1) % a.n)+1],
           0,now() - ((s.match_seq % 365)||' days')::interval,
           now() - ((s.match_seq % 365)||' days')::interval + interval '20 seconds','normal'
    FROM shaped s CROSS JOIN available a
    ON CONFLICT DO NOTHING
  `));

  const answers = Math.min(plan.match_answers.desiredSeed, questions * 2);
  await batches('match_answers', answers, 50_000, (start, end) => sql.unsafe(`
    WITH shaped AS (
      SELECT g,((g - 1) % ${questions}) + 1 AS question_seq,((g - 1) / ${questions})::int AS answer_no
      FROM generate_series(${start},${end}) g
    ), mapped AS (
      SELECT g,answer_no,((question_seq - 1) % ${matches}) + 1 AS match_seq,
             ((question_seq - 1) / ${matches})::int AS q_index
      FROM shaped
    )
    INSERT INTO public.match_answers
      (match_id,q_index,user_id,selected_index,is_correct,time_ms,points_earned,answered_at,phase_kind,answer_payload)
    SELECT ${seedMatchId('m.match_seq')},m.q_index,
           ${seedUserId(`((((m.match_seq - 1) * 2 + m.answer_no) % ${users}) + 1)`)},
           (m.g % 4)::int,(m.g % 3 <> 0),(1000 + m.g % 7000)::int,
           CASE WHEN m.g % 3 <> 0 THEN 100 ELSE 0 END,
           now() - ((m.match_seq % 365)||' days')::interval,'normal','{}'::jsonb
    FROM mapped m
    ON CONFLICT DO NOTHING
  `));

  const goals = Math.min(plan.match_goal_events.desiredSeed, matches * 4);
  await batches('match_goal_events', goals, 50_000, (start, end) => sql.unsafe(`
    WITH shaped AS (
      SELECT g,((g - 1) % ${matches}) + 1 AS match_seq,((g - 1) / ${matches})::int AS q_index
      FROM generate_series(${start},${end}) g
    )
    INSERT INTO public.match_goal_events
      (id,match_id,user_id,seat,half,phase_kind,q_index,is_penalty,created_at)
    SELECT md5('${MARKER}:goal:'||s.g)::uuid,${seedMatchId('s.match_seq')},
           ${seedUserId(`((((s.match_seq - 1) * 2 + (s.g % 2)) % ${users}) + 1)`)},
           ((s.g % 2)+1)::smallint,((s.g % 2)+1)::smallint,'normal',s.q_index,false,
           now() - ((s.match_seq % 365)||' days')::interval
    FROM shaped s ON CONFLICT DO NOTHING
  `));

  const profiles = Math.min(plan.ranked_profiles.desiredSeed, users);
  await batches('ranked_profiles', profiles, 10_000, (start, end) => sql.unsafe(`
    INSERT INTO public.ranked_profiles
      (user_id,rp,tier,placement_status,placement_required,placement_played,placement_wins,
       current_win_streak,last_ranked_match_at)
    SELECT ${seedUserId('g')},(300 + g % 3000)::int,
           CASE WHEN g % 3000 > 2500 THEN 'World-Class' WHEN g % 3000 > 1500 THEN 'Starting11' ELSE 'Academy' END,
           'placed',3,3,(g % 4)::smallint,(g % 8)::smallint,
           now() - ((g % 90)||' days')::interval
    FROM generate_series(${start},${end}) g
    ON CONFLICT (user_id) DO NOTHING
  `));

  const stats = Math.min(plan.user_mode_match_stats.desiredSeed, users * 2);
  await batches('user_mode_match_stats', stats, 20_000, (start, end) => sql.unsafe(`
    INSERT INTO public.user_mode_match_stats
      (user_id,mode,games_played,wins,losses,draws,last_match_at)
    SELECT ${seedUserId(`((g - 1) % ${users}) + 1`)},
           CASE WHEN g <= ${users} THEN 'ranked' ELSE 'friendly' END,
           (10 + g % 200)::int,(g % 80)::int,(g % 70)::int,(g % 20)::int,
           now() - ((g % 90)||' days')::interval
    FROM generate_series(${start},${end}) g
    ON CONFLICT (user_id,mode) DO NOTHING
  `));

  const rpChanges = Math.min(plan.ranked_rp_changes.desiredSeed, matches * 2);
  await batches('ranked_rp_changes', rpChanges, 50_000, (start, end) => sql.unsafe(`
    WITH shaped AS (
      SELECT g,((g - 1) / 2) + 1 AS match_seq,(g - 1) % 2 AS seat_no
      FROM generate_series(${start},${end}) g
    )
    INSERT INTO public.ranked_rp_changes
      (id,match_id,user_id,opponent_user_id,opponent_is_ai,old_rp,delta_rp,new_rp,
       result,is_placement,calculation_method,created_at,coins_awarded)
    SELECT md5('${MARKER}:rp:'||s.g)::uuid,${seedMatchId('s.match_seq')},
           ${seedUserId(`((((s.match_seq - 1) * 2 + s.seat_no) % ${users}) + 1)`)},
           ${seedUserId(`((((s.match_seq - 1) * 2 + (1 - s.seat_no)) % ${users}) + 1)`)},
           false,600,CASE WHEN s.seat_no=0 THEN 12 ELSE -12 END,
           CASE WHEN s.seat_no=0 THEN 612 ELSE 588 END,
           CASE WHEN s.seat_no=0 THEN 'win' ELSE 'loss' END,
           false,'ranked_formula',now() - ((s.match_seq % 365)||' days')::interval,
           CASE WHEN s.seat_no=0 THEN 25 ELSE 10 END
    FROM shaped s ON CONFLICT DO NOTHING
  `));

  await sql`ANALYZE public.users`;
  await sql`ANALYZE public.lobbies`;
  await sql`ANALYZE public.matches`;
  await sql`ANALYZE public.match_players`;
  await sql`ANALYZE public.match_questions`;
  await sql`ANALYZE public.match_answers`;
  await sql`ANALYZE public.match_goal_events`;
  await sql`ANALYZE public.ranked_profiles`;
  await sql`ANALYZE public.user_mode_match_stats`;
  await sql`ANALYZE public.ranked_rp_changes`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertTargetSafe(args);
  const sql = postgres(args.databaseUrl, {
    max: 2,
    connect_timeout: 15,
    idle_timeout: 20,
    prepare: false,
  });
  try {
    const identity = await sql<{ database: string; serverVersion: string }[]>`
      SELECT current_database() AS database,current_setting('server_version') AS "serverVersion"
    `;
    console.log(`target=${args.target} database=${identity[0]?.database} postgres=${identity[0]?.serverVersion}`);
    if (args.reset) {
      if (!args.apply) throw new Error('--reset requires --apply.');
      await resetSeed(sql);
    }
    const contentBefore = args.target === 'local' ? await localContentPlan(sql) : null;
    if (contentBefore) console.table(Object.entries(contentBefore).map(([table, entry]) => ({ table, ...entry })));
    const before = await plans(sql);
    console.table(Object.entries(before).map(([table, entry]) => ({ table, ...entry })));
    if (!args.apply) {
      console.log('DRY RUN only. Pass --apply to generate tagged synthetic rows.');
      return;
    }
    if (contentBefore) await seedLocalContent(sql, contentBefore);
    await seed(sql, before);
    const contentAfter = args.target === 'local' ? await localContentPlan(sql) : null;
    const after = await plans(sql);
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      target: args.target,
      marker: MARKER,
      productionDataCopied: false,
      contentBefore,
      contentAfter,
      before,
      after,
    };
    mkdirSync(dirname(args.reportPath), { recursive: true });
    writeFileSync(args.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.table(Object.entries(after).map(([table, entry]) => ({ table, ...entry })));
    console.log(`Seed report: ${args.reportPath}`);
  } finally {
    await sql.end({ timeout: 10 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
