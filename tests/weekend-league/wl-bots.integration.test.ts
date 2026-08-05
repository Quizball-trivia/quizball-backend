/**
 * Bot participants + prize firewall, end to end against real DB + Redis:
 * a 2-human field with bot_fill_min_field=6 gets topped up by 4 roster bots
 * at check-in, the bots play every question through the real accept path
 * (hash-stable accuracy), out-score the always-wrong humans, and the awards
 * settlement still pays HUMANS ONLY — every band cascades past bots, and no
 * bot ever touches the QP wallet.
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
  in() {
    return { socketsLeave() { /* eviction sink */ } };
  },
} as unknown as import('../../src/realtime/socket-server.js').QuizballServer;

const i18n = (base: string) => ({ en: `${base} en`, ka: `${base} ka` });

async function seedSource(type: string, payload: Record<string, unknown>): Promise<string> {
  const [q] = await sql<{ id: string }[]>`
    INSERT INTO questions (category_id, type, difficulty, status, ranked_eligible, visibility, prompt)
    VALUES (${categoryId}, ${type}, 'medium', 'published', true, 'wl_private',
            ${sql.json(i18n(`bt-${type}-${testQuestionIds.length}`) as never)})
    RETURNING id
  `;
  await sql`INSERT INTO question_payloads (question_id, payload) VALUES (${q.id}, ${sql.json(payload as never)})`;
  testQuestionIds.push(q.id);
  return q.id;
}

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
      matchups: [0, 1, 2, 3, 4].map((m) => ({
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
    console.warn('\n⚠️  Skipping WL bots tests: DB or Redis unavailable.\n');
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

describe('WL bots + prize firewall', () => {
  it('fills the field with bots that play but never win prizes', async ({ skip }) => {
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
        free_entry: true,
        question_time_ms: 1_000,
        dispatch_lead_ms: 0,
        break_ms: 2_000,
        checkin_window_ms: 60_000,
        bot_fill_min_field: 6,
      }),
      entryOpensAt: new Date(now - 3600_000),
      entryClosesAt: new Date(now - 120_000),
      qualifierStartsAt: new Date(now - 30_000),
      finalStartsAt: new Date(now + 150_000),
      redisTimeMs: now,
      status: 'scheduled',
    });
    if (!created) throw new Error('create failed');
    testTournamentIds.push(created.id);
    const tid = created.id;

    // 2 humans + 5 roster bots available (only 4 should be drafted).
    const stamp = Date.now();
    const humans: string[] = [];
    for (const name of ['wlb-h1', 'wlb-h2']) {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO users (nickname, is_ai, is_seed, coins, onboarding_complete)
        VALUES (${`${name}-${stamp}`}, false, false, 0, true) RETURNING id
      `;
      testUserIds.push(u.id);
      humans.push(u.id);
      await sql`
        INSERT INTO wl_entries (tournament_id, user_id, checked_in_at, final_checked_in_at)
        VALUES (${tid}, ${u.id}, NOW(), NOW())
      `;
    }
    const botIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO users (nickname, is_ai, ai_kind, is_seed, coins, onboarding_complete)
        VALUES (${`wlb-bot${i}-${stamp}`}, true, 'persistent', false, 0, true) RETURNING id
      `;
      testUserIds.push(u.id);
      botIds.push(u.id);
    }

    // Compressed cuts for 6: 6 → 4 → 3 → 2 finalists.
    let ladderOverridden = false;

    const wrongAnswerFor = (kind: string): unknown => {
      switch (kind) {
        case 'mcq': return 'not-an-option';
        case 'true_false': return 'false';
        case 'higher_lower': return 'right'; // left is correct in fixtures
        case 'career_path': return 'nobody';
        case 'who_am_i': return { guess: 'nobody' };
        default: return null;
      }
    };
    const correctAnswerFor = (kind: string): unknown => {
      switch (kind) {
        case 'mcq': return 'o0';
        case 'true_false': return 'true';
        case 'higher_lower': return 'left';
        case 'career_path': return 'Zidane';
        case 'who_am_i': return { guess: 'kaka' };
        default: return null;
      }
    };

    const answeredAttempts = new Set<string>();
    const deadline = Date.now() + 280_000;
    let lastStatus = '';
    for (;;) {
      if (Date.now() > deadline) throw new Error('tournament did not finish in time');
      await wlOrchestratorTick(fakeIo);
      const t = await wlOrchestratorRepo.getById(tid);
      if (!t) throw new Error('tournament vanished');
      if (t.status !== lastStatus) {
        console.log(`BOTS ${t.status}`);
        lastStatus = t.status;
      }
      if (t.status === 'completed') break;
      if (!ladderOverridden && ['game_live', 'break'].includes(t.status)) {
        await sql`
          UPDATE wl_tournaments
          SET ladder = ${sql.json({ fieldSize: 6, advance: [4, 3, 2] } as never)}
          WHERE id = ${tid}
        `;
        ladderOverridden = true;
      }
      // Human policy engineered to exercise the FULL firewall:
      //  - h1 answers wrong everywhere → eliminated by bots at the first cut
      //    (a weak human really can lose their spot to a bot on merit)
      //  - h2 aces the qualifiers but throws the FINAL → a BOT tops the final
      //    board, and the champion PRIZE must cascade to h2
      const [run] = await sql<Array<{ attempt_id: string; question_id: string; game_index: number }>>`
        SELECT r.attempt_id, r.question_id, r.game_index FROM wl_question_runs r
        WHERE r.tournament_id = ${tid} AND r.status = 'dispatched'
        ORDER BY r.game_index DESC, r.round_index DESC, r.question_index DESC LIMIT 1
      `;
      if (run && !answeredAttempts.has(run.attempt_id)) {
        answeredAttempts.add(run.attempt_id);
        const [q] = await sql<Array<{ kind: string }>>`
          SELECT kind FROM wl_questions WHERE question_id = ${run.question_id}
        `;
        const alive = await sql<Array<{ user_id: string }>>`
          SELECT user_id FROM wl_game_participants
          WHERE tournament_id = ${tid} AND game_index = ${run.game_index}
        `;
        const aliveSet = new Set(alive.map((a) => a.user_id));
        const [h1, h2] = humans as [string, string];
        if (aliveSet.has(h1)) {
          await wlAcceptAnswer({
            tournamentId: tid, attemptId: run.attempt_id, userId: h1,
            answer: wrongAnswerFor(q!.kind),
          });
        }
        if (aliveSet.has(h2)) {
          const throwsFinal = run.game_index === 3;
          await wlAcceptAnswer({
            tournamentId: tid, attemptId: run.attempt_id, userId: h2,
            answer: throwsFinal ? wrongAnswerFor(q!.kind) : correctAnswerFor(q!.kind),
          });
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // ── Field was topped up to exactly 6 by 4 bots, all pre-checked-in ──
    const entries = await sql<Array<{ user_id: string; is_ai: boolean }>>`
      SELECT e.user_id, u.is_ai FROM wl_entries e JOIN users u ON u.id = e.user_id
      WHERE e.tournament_id = ${tid}
    `;
    expect(entries.length).toBe(6);
    expect(entries.filter((e) => e.is_ai).length).toBe(4);

    // ── Bots actually played (accepted answers with points on the board) ──
    const scores = await sql<Array<{ user_id: string; is_ai: boolean; points: number }>>`
      SELECT a.user_id, u.is_ai, COALESCE(SUM(a.points), 0)::int AS points
      FROM wl_answers a JOIN users u ON u.id = a.user_id
      WHERE a.tournament_id = ${tid} AND a.game_index = 0
      GROUP BY a.user_id, u.is_ai
    `;
    const botPoints = scores.filter((s) => s.is_ai).map((s) => s.points);
    expect(botPoints.length).toBe(4);
    expect(Math.max(...botPoints)).toBeGreaterThan(0);
    // The always-wrong human was out-scored by bots (merit elimination).
    const h1Points = scores.find((s) => s.user_id === humans[0])?.points ?? 0;
    expect(Math.max(...botPoints)).toBeGreaterThan(h1Points);

    // ── A BOT won the final on merit… ──
    const [tourFinal] = await sql<Array<{ champion_user_id: string | null }>>`
      SELECT champion_user_id FROM wl_tournaments WHERE id = ${tid}
    `;
    const [champIsBot] = await sql<Array<{ is_ai: boolean }>>`
      SELECT is_ai FROM users WHERE id = ${tourFinal!.champion_user_id}
    `;
    expect(champIsBot?.is_ai).toBe(true);

    // ── …but the champion PRIZE cascaded to the best HUMAN ──
    const awards = await sql<Array<{ user_id: string; band: string; is_ai: boolean }>>`
      SELECT a.user_id, a.band, u.is_ai FROM wl_awards a JOIN users u ON u.id = a.user_id
      WHERE a.tournament_id = ${tid}
    `;
    expect(awards.length).toBeGreaterThan(0);
    expect(awards.every((a) => !a.is_ai)).toBe(true);
    const champAward = awards.find((a) => a.band === 'champion');
    expect(champAward?.user_id).toBe(humans[1]);

    // ── Bots never touch the QP wallet ──
    const [botQp] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM wl_qp_awards
      WHERE user_id = ANY(${sql.array(botIds)}::uuid[])
    `;
    expect(botQp?.n ?? 0).toBe(0);
  }, 300_000);
});
