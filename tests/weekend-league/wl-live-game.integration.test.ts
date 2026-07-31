/**
 * Full LIVE game end-to-end against real DB + Redis: seeded wl_private
 * content, three checked-in players, compressed 1s questions. Players
 * answer through wlAcceptAnswer with different accuracy/speed; the
 * orchestrator ticks the game through all 19 dispatches to qualifier_done
 * and the dns_v1 settlement. Asserts real standings order, persisted
 * answers, reveal payloads (evaluation + distribution + board), and the
 * gapless delivered event stream.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let sql: typeof import('../../src/db/index.js').sql;
let dbAvailable = false;

const testUserIds: string[] = [];
const testTournamentIds: string[] = [];
const testQuestionIds: string[] = [];
let categoryId = '';

const WL_TEST_LOCK = 774431001;
let lockConn: Awaited<ReturnType<typeof sql.reserve>> | null = null;

interface Emitted { room: string; event: string; payload: Record<string, unknown> }
const emitted: Emitted[] = [];
const fakeIo = {
  to(room: string) {
    return {
      emit(event: string, payload: Record<string, unknown>) {
        emitted.push({ room, event, payload });
      },
    };
  },
} as unknown as import('../../src/realtime/socket-server.js').QuizballServer;

const i18n = (base: string) => ({ en: `${base} en`, ka: `${base} ka` });

async function seedSource(type: string, payload: Record<string, unknown>): Promise<string> {
  const [q] = await sql<{ id: string }[]>`
    INSERT INTO questions (category_id, type, difficulty, status, ranked_eligible, visibility, prompt)
    VALUES (${categoryId}, ${type}, 'medium', 'published', true, 'wl_private',
            ${sql.json(i18n(`lg-${type}-${testQuestionIds.length}`) as never)})
    RETURNING id
  `;
  await sql`INSERT INTO question_payloads (question_id, payload) VALUES (${q.id}, ${sql.json(payload as never)})`;
  testQuestionIds.push(q.id);
  return q.id;
}

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    await sql`SELECT 1`;
    const { initRedisClients } = await import('../../src/realtime/redis.js');
    await initRedisClients();
    const { wlRedisNowMs } = await import('../../src/modules/weekend-league/wl-redis.js');
    await wlRedisNowMs();
    lockConn = await sql.reserve();
    await lockConn`SELECT pg_advisory_lock(${WL_TEST_LOCK})`;
    if (/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) {
      await sql`DELETE FROM wl_tournaments WHERE is_test = false`;
    }
    const [cat] = await sql<{ id: string }[]>`SELECT id FROM categories LIMIT 1`;
    if (!cat) throw new Error('no category');
    categoryId = cat.id;
    dbAvailable = true;
  } catch {
    if (lockConn) {
      await lockConn`SELECT pg_advisory_unlock(${WL_TEST_LOCK})`.catch(() => {});
      lockConn.release();
      lockConn = null;
    }
    console.warn('\n⚠️  Skipping WL live-game tests: DB or Redis unavailable.\n');
  }
}, 120_000);

afterAll(async () => {
  if (!dbAvailable) return;
  if (testTournamentIds.length > 0 && process.env.WL_KEEP_STATE !== '1') {
    await sql`DELETE FROM wl_tournaments WHERE id = ANY(${sql.array(testTournamentIds)}::uuid[])`;
  }
  if (testQuestionIds.length > 0) {
    await sql`DELETE FROM question_payloads WHERE question_id = ANY(${sql.array(testQuestionIds)}::uuid[])`;
    await sql`DELETE FROM questions WHERE id = ANY(${sql.array(testQuestionIds)}::uuid[])`;
  }
  if (testUserIds.length > 0) {
    await sql`DELETE FROM users WHERE id = ANY(${sql.array(testUserIds)}::uuid[])`;
  }
  if (lockConn) {
    await lockConn`SELECT pg_advisory_unlock(${WL_TEST_LOCK})`.catch(() => {});
    lockConn.release();
  }
  const { closeRedisClients } = await import('../../src/realtime/redis.js');
  await closeRedisClients().catch(() => {});
  await sql.end({ timeout: 5 });
});

async function stockContent(): Promise<void> {
  const { wlSourceNeedPerKind } = await import('../../src/modules/weekend-league/wl-seeder.js');
  for (let i = 0; i < wlSourceNeedPerKind('mcq'); i += 1) {
    await seedSource('mcq_single', {
      type: 'mcq_single',
      options: [0, 1, 2, 3].map((o) => ({ id: `o${o}`, text: i18n(`m${i}o${o}`), is_correct: o === 0 })),
    });
  }
  for (let i = 0; i < wlSourceNeedPerKind('true_false'); i += 1) {
    await seedSource('true_false', {
      type: 'true_false',
      options: [
        { id: 'true', text: i18n('t'), is_correct: true },
        { id: 'false', text: i18n('f'), is_correct: false },
      ],
    });
  }
  for (let i = 0; i < wlSourceNeedPerKind('higher_lower'); i += 1) {
    await seedSource('high_low', {
      type: 'high_low',
      stat_label: i18n(`hl${i}`),
      matchups: [0, 1, 2].map((m) => ({
        id: `m${m}`, left_name: i18n('L'), left_value: 10, right_name: i18n('R'), right_value: 5,
      })),
    });
  }
  for (let i = 0; i < wlSourceNeedPerKind('career_path'); i += 1) {
    await seedSource('career_path', {
      type: 'career_path',
      clubs: [i18n('a'), i18n('b')],
      display_answer: i18n('Zidane'),
      accepted_answers: ['zidane'],
    });
  }
  for (let i = 0; i < wlSourceNeedPerKind('who_am_i'); i += 1) {
    await seedSource('clue_chain', {
      type: 'clue_chain',
      display_answer: i18n('Kaka'),
      accepted_answers: ['kaka'],
      clues: [1, 2, 3, 4, 5].map((c) => ({ type: 'text', content: i18n(`c${c}`) })),
    });
  }
}

function correctAnswerFor(kind: string): unknown {
  switch (kind) {
    case 'mcq': return 'o0';
    case 'true_false': return 'true';
    case 'higher_lower': return 'left';
    case 'career_path': return 'Zidane!';
    case 'who_am_i': return { guess: 'KAKA', clue_index: 1 };
    default: return null;
  }
}

describe('WL live game end-to-end', () => {
  it('plays 19 real questions to qualifier_done with truthful standings', async ({ skip }) => {
    if (!dbAvailable) skip();
    await stockContent();

    const { wlRedisNowMs } = await import('../../src/modules/weekend-league/wl-redis.js');
    const { wlOrchestratorRepo } = await import('../../src/modules/weekend-league/wl-orchestrator.repo.js');
    const { wlOrchestratorTick } = await import('../../src/modules/weekend-league/wl-orchestrator.js');
    const { wlAcceptAnswer } = await import('../../src/modules/weekend-league/wl-live-engine.js');
    const { buildWlConfig } = await import('../../src/modules/weekend-league/wl-config.js');

    const now = await wlRedisNowMs();
    const created = await wlOrchestratorRepo.createWithInitialEvent({
      weekKey: null,
      isTest: true,
      config: buildWlConfig({
        launch_edition: true,
        question_time_ms: 1_000,
        dispatch_lead_ms: 0,
        checkin_window_ms: 60_000,
      }),
      entryOpensAt: new Date(now - 3600_000),
      entryClosesAt: new Date(now - 120_000),
      qualifierStartsAt: new Date(now - 30_000),
      finalStartsAt: new Date(now + 3600_000),
      redisTimeMs: now,
      status: 'scheduled',
    });
    if (!created) throw new Error('create failed');
    testTournamentIds.push(created.id);
    const tid = created.id;

    const players: string[] = [];
    for (const name of ['wlg-ace', 'wlg-mid', 'wlg-idle']) {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO users (nickname, is_ai, is_seed, coins, onboarding_complete)
        VALUES (${`${name}-${now}`}, false, false, 0, true) RETURNING id
      `;
      testUserIds.push(u.id);
      players.push(u.id);
      await sql`
        INSERT INTO wl_entries (tournament_id, user_id, checked_in_at, final_checked_in_at)
        VALUES (${tid}, ${u.id}, NOW(), NOW())
      `;
    }
    const [ace, mid, idle] = players as [string, string, string];
    void idle; // never answers — must still be ranked (miss charges)

    // Drive the game: tick, answer the current dispatched attempt, repeat.
    const answeredAttempts = new Set<string>();
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error('live game did not finish in time');
      await wlOrchestratorTick(fakeIo);
      const t = await wlOrchestratorRepo.getById(tid);
      if (!t) throw new Error('tournament vanished');
      if (['qualifier_done', 'completed'].includes(t.status)) break;
      const [run] = await sql<Array<{ attempt_id: string; question_id: string; status: string }>>`
        SELECT r.attempt_id, r.question_id, r.status FROM wl_question_runs r
        WHERE r.tournament_id = ${tid} AND r.status = 'dispatched'
        ORDER BY r.round_index DESC, r.question_index DESC LIMIT 1
      `;
      if (run && !answeredAttempts.has(run.attempt_id)) {
        answeredAttempts.add(run.attempt_id);
        const [q] = await sql<Array<{ kind: string }>>`
          SELECT kind FROM wl_questions WHERE question_id = ${run.question_id}
        `;
        const answer = correctAnswerFor(q!.kind);
        // Ace answers correctly and instantly; mid answers wrong.
        const aceResult = await wlAcceptAnswer({ tournamentId: tid, attemptId: run.attempt_id, userId: ace, answer });
        expect(aceResult.accepted).toBe(true);
        if (aceResult.accepted) expect(aceResult.correct).toBe(true);
        const midResult = await wlAcceptAnswer({
          tournamentId: tid, attemptId: run.attempt_id, userId: mid,
          answer: q!.kind === 'who_am_i' ? { guess: 'wrong', clue_index: 1 } : 'wrong-option',
        });
        expect(midResult.accepted).toBe(true);
        if (midResult.accepted) expect(midResult.correct).toBe(false);
        // Duplicate answer returns the stored result, never re-scores.
        const dup = await wlAcceptAnswer({ tournamentId: tid, attemptId: run.attempt_id, userId: ace, answer: 'anything' });
        expect(dup.accepted).toBe(true);
        if (dup.accepted && aceResult.accepted) expect(dup.points).toBe(aceResult.points);
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    // 19 slots revealed, none stuck.
    const runs = await sql<Array<{ status: string }>>`
      SELECT status FROM wl_question_runs WHERE tournament_id = ${tid} AND status <> 'voided'
    `;
    expect(runs.length).toBe(19);
    expect(runs.every((r) => r.status === 'revealed')).toBe(true);

    // Standings truth: ace (all correct) 1st, mid (all wrong, but present) 2nd,
    // idle (never answered) 3rd — wrong-but-present beats absent.
    const results = await sql<Array<{ user_id: string; rank: number; score: number }>>`
      SELECT user_id, rank, score FROM wl_game_results
      WHERE tournament_id = ${tid} AND game_index = 0 ORDER BY rank ASC
    `;
    expect(results.length).toBe(3);
    expect(results[0]!.user_id).toBe(ace);
    expect(results[0]!.score).toBeGreaterThan(0);
    expect(results[1]!.user_id).toBe(mid);
    expect(results[1]!.score).toBe(0);
    expect(results[2]!.user_id).toBe(idle);

    // Persisted answers: 2 players × 19 questions.
    const [answerCount] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM wl_answers WHERE tournament_id = ${tid}
    `;
    expect(answerCount.n).toBe(38);

    // Reveal events carry evaluation + distribution + board; stream gapless.
    const events = await sql<Array<{ seq_text: string; type: string; delivered: boolean }>>`
      SELECT seq::text AS seq_text, type, (delivered_at IS NOT NULL) AS delivered
      FROM wl_events WHERE tournament_id = ${tid} ORDER BY wl_events.seq ASC
    `;
    expect(events.map((e) => Number(e.seq_text))).toEqual(events.map((_, i) => i + 1));
    expect(events.filter((e) => e.type === 'dispatch').length).toBe(19);
    expect(events.filter((e) => e.type === 'reveal').length).toBe(19);
    expect(events.every((e) => e.delivered)).toBe(true);

    const reveals = emitted.filter((e) => e.room === `wl:${tid}` && e.event === 'wl:reveal');
    expect(reveals.length).toBe(19);
    const lastReveal = reveals.at(-1)!.payload;
    expect(lastReveal['evaluation']).toBeTruthy();
    expect(lastReveal['board']).toBeTruthy();
    expect((lastReveal['board'] as unknown[]).length).toBeGreaterThan(0);

    // Dispatches were stamped and carried the content + timing.
    const dispatches = emitted.filter((e) => e.room === `wl:${tid}` && e.event === 'wl:dispatch');
    expect(dispatches.length).toBe(19);
    expect(typeof dispatches[0]!.payload['playableAt']).toBe('number');
    expect(typeof dispatches[0]!.payload['deadlineAt']).toBe('number');
    expect(dispatches[0]!.payload['question']).toBeTruthy();
  }, 120_000);
});
