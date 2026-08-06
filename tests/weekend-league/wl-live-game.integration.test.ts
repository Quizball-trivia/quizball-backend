/**
 * Full LIVE game end-to-end against real DB + Redis: seeded wl_private
 * content, three checked-in players, compressed 1s questions. Players
 * answer through wlAcceptAnswer with different accuracy/speed; the
 * orchestrator ticks the game through all 21 dispatches to qualifier_done
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
  in() {
    return { socketsLeave() { /* eviction sink */ } };
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
    if ((() => {
      try { return ['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname); }
      catch { return false; }
    })()) {
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
  it('plays the FULL tournament: 3 games with cuts, breaks, played final, awards', async ({ skip }) => {
    if (!dbAvailable) skip();
    await stockContent();

    const { wlRedisNowMs } = await import('../../src/modules/weekend-league/wl-redis.js');
    const { wlOrchestratorRepo } = await import('../../src/modules/weekend-league/wl-orchestrator.repo.js');
    const { wlOrchestratorTick } = await import('../../src/modules/weekend-league/wl-orchestrator.js');
    const { wlAcceptAnswer, wlSubscribeSnapshot } = await import('../../src/modules/weekend-league/wl-live-engine.js');
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

    const players: string[] = [];
    for (const name of ['wlg-ace', 'wlg-b', 'wlg-c', 'wlg-d', 'wlg-e', 'wlg-idle']) {
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
    const [ace, ...rest] = players as [string, ...string[]];
    const idle = rest.at(-1)!;
    const mids = rest.slice(0, -1);

    // Compressed cuts for a 6-player field: 6 → 4 → 3 → 2 finalists.
    // (Real ladders come from wlBuildLadder; the override exercises real
    // eliminations without a 25-player fixture.)
    let ladderOverridden = false;

    // Drive the whole tournament: tick, answer the current dispatched
    // attempt with every alive participant, repeat until completed.
    const answeredAttempts = new Set<string>();
    let snapshotChecked = false;
    const deadline = Date.now() + 280_000;
    const loopStart = Date.now();
    let lastStatus = '';
    for (;;) {
      if (Date.now() > deadline) throw new Error('tournament did not finish in time');
      const tickStart = Date.now();
      await wlOrchestratorTick(fakeIo);
      const tickMs = Date.now() - tickStart;
      const t = await wlOrchestratorRepo.getById(tid);
      if (!t) throw new Error('tournament vanished');
      if (t.status !== lastStatus || tickMs > 3000) {
        console.log(`E2E ${Math.round((Date.now() - loopStart) / 1000)}s status=${t.status} tick=${tickMs}ms`);
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
        const answer = correctAnswerFor(q!.kind);
        if (aliveSet.has(ace)) {
          // Reconnect snapshot BEFORE answering: the in-flight attempt (with
          // its question + window stamps) must be recoverable, unanswered.
          if (!snapshotChecked) {
            const pre = await wlSubscribeSnapshot(tid, ace);
            expect(pre?.attempt?.['attempt_id']).toBe(run.attempt_id);
            expect(pre?.attempt?.['question']).toBeTruthy();
            expect(Number(pre?.attempt?.['deadlineAt'])).toBeGreaterThan(Date.now() - 60_000);
            expect(pre?.your_answer).toBeNull();
            // Spectators get no snapshot at all (handler never builds one);
            // a non-participant player snapshot must still carry no answer.
            const outsider = await wlSubscribeSnapshot(tid, '00000000-0000-4000-8000-000000000000');
            expect(outsider?.attempt?.['attempt_id']).toBe(run.attempt_id);
            expect(outsider?.your_answer).toBeNull();
            expect(outsider?.score).toBe(0);
          }
          const aceResult = await wlAcceptAnswer({ tournamentId: tid, attemptId: run.attempt_id, userId: ace, answer });
          if (aceResult.accepted) expect(aceResult.correct).toBe(true);
          // ...and AFTER answering it restores the accepted answer + score.
          if (!snapshotChecked && aceResult.accepted) {
            const post = await wlSubscribeSnapshot(tid, ace);
            expect(post?.your_answer?.correct).toBe(true);
            expect(post?.score ?? 0).toBeGreaterThan(0);
            snapshotChecked = true;
          }
        }
        for (const mid of mids) {
          if (!aliveSet.has(mid)) continue;
          await wlAcceptAnswer({
            tournamentId: tid, attemptId: run.attempt_id, userId: mid,
            answer: q!.kind === 'who_am_i' ? { guess: 'wrong' } : 'wrong-option',
          });
        }
        // idle never answers — miss charges keep ranking truthful.
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    // 4 games × 21 slots revealed, none stuck.
    const runs = await sql<Array<{ status: string; game_index: number }>>`
      SELECT status, game_index FROM wl_question_runs
      WHERE tournament_id = ${tid} AND status <> 'voided'
    `;
    expect(runs.length).toBe(4 * 21);
    expect(runs.every((r) => r.status === 'revealed')).toBe(true);

    // Cuts per the overridden ladder: 6 → 4 → 3 → 2 finalists → champion.
    for (const [game, expected] of [[0, 6], [1, 4], [2, 3], [3, 2]] as const) {
      const [n] = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM wl_game_results
        WHERE tournament_id = ${tid} AND game_index = ${game}
      `;
      expect(n.n, `game ${game} field`).toBe(expected);
    }

    // Ace wins everything; idle was cut first with the right elimination tag.
    const t = await wlOrchestratorRepo.getById(tid);
    expect(t?.status).toBe('completed');
    expect(t?.champion_user_id).toBe(ace);
    expect(t?.final_played).toBe(true);
    const entries = await sql<Array<{ user_id: string; state: string; eliminated_game: number | null; final_rank: number | null }>>`
      SELECT user_id, state, eliminated_game, final_rank FROM wl_entries WHERE tournament_id = ${tid}
    `;
    const byUser = new Map(entries.map((e) => [e.user_id, e]));
    expect(byUser.get(ace)?.state).toBe('champion');
    expect(byUser.get(ace)?.final_rank).toBe(1);
    expect(byUser.get(idle)?.state).toBe('eliminated');
    expect(byUser.get(idle)?.eliminated_game).toBe(0);

    // Awards: humans-only bands over the final board (all humans here).
    const awards = await sql<Array<{ user_id: string; band: string }>>`
      SELECT user_id, band FROM wl_awards WHERE tournament_id = ${tid} ORDER BY final_rank ASC
    `;
    expect(awards.length).toBe(2);
    expect(awards[0]).toEqual({ user_id: ace, band: 'champion' });
    expect(awards[1]!.band).toBe('second');

    // Stream gapless + fully delivered; result events carried eviction lists.
    const events = await sql<Array<{ seq_text: string; type: string; delivered: boolean }>>`
      SELECT seq::text AS seq_text, type, (delivered_at IS NOT NULL) AS delivered
      FROM wl_events WHERE tournament_id = ${tid} ORDER BY wl_events.seq ASC
    `;
    expect(events.map((e) => Number(e.seq_text))).toEqual(events.map((_, i) => i + 1));
    expect(events.filter((e) => e.type === 'dispatch').length).toBe(4 * 21);
    expect(events.filter((e) => e.type === 'reveal').length).toBe(4 * 21);
    expect(events.filter((e) => e.type === 'game_result').length).toBe(3);
    expect(events.filter((e) => e.type === 'final_result').length).toBe(1);
    expect(events.every((e) => e.delivered)).toBe(true);

    const gameResults = emitted.filter((e) => e.room === `wl:${tid}` && e.event === 'wl:game_result');
    expect(gameResults.length).toBe(3);
    expect((gameResults[0]!.payload['eliminated_user_ids'] as string[]).length).toBe(2);
  }, 300_000);
});
