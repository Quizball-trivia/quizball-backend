/**
 * Spectator delay invariants against real DB + Redis: with a 3s configured
 * delay, spectator-room emissions of every event trail its live emission by
 * at least the delay, arrive in the same gapless seq order, and the
 * spectator cursor only advances monotonically. Also proves the delayed
 * dispatch replay is self-contained (carries the persisted timing stamps).
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

interface Emitted { room: string; event: string; payload: Record<string, unknown>; atMs: number }
const emitted: Emitted[] = [];
const fakeIo = {
  to(room: string) {
    return {
      emit(event: string, payload: Record<string, unknown>) {
        emitted.push({ room, event, payload, atMs: Date.now() });
      },
    };
  },
  in() {
    return { socketsLeave() { /* sink */ } };
  },
} as unknown as import('../../src/realtime/socket-server.js').QuizballServer;

const i18n = (base: string) => ({ en: `${base} en`, ka: `${base} ka` });

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
    console.warn('\n⚠️  Skipping WL spectator tests: DB or Redis unavailable.\n');
  }
}, 120_000);

afterAll(async () => {
  if (!dbAvailable) return;
  if (testTournamentIds.length > 0) {
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

describe('WL spectator delay', () => {
  it('spec room trails live by >= the configured delay, gapless and monotonic', async ({ skip }) => {
    if (!dbAvailable) skip();

    const { wlSourceNeedPerKind } = await import('../../src/modules/weekend-league/wl-seeder.js');
    const { wlRedisNowMs } = await import('../../src/modules/weekend-league/wl-redis.js');
    const { wlOrchestratorRepo } = await import('../../src/modules/weekend-league/wl-orchestrator.repo.js');
    const { wlOrchestratorTick } = await import('../../src/modules/weekend-league/wl-orchestrator.js');
    const { buildWlConfig } = await import('../../src/modules/weekend-league/wl-config.js');

    // Minimal stock for a seedable tournament (public bank allowed).
    const stock: Array<[string, number, (i: number) => Record<string, unknown>]> = [
      ['mcq_single', wlSourceNeedPerKind('mcq'), (i) => ({
        type: 'mcq_single',
        options: [0, 1, 2, 3].map((o) => ({ id: `o${o}`, text: i18n(`s${i}o${o}`), is_correct: o === 0 })),
      })],
      ['true_false', wlSourceNeedPerKind('true_false'), () => ({
        type: 'true_false',
        options: [
          { id: 'true', text: i18n('t'), is_correct: true },
          { id: 'false', text: i18n('f'), is_correct: false },
        ],
      })],
      ['high_low', wlSourceNeedPerKind('higher_lower'), (i) => ({
        type: 'high_low', stat_label: i18n(`h${i}`),
        matchups: [0, 1, 2, 3, 4].map((m) => ({
          id: `m${m}`, left_name: i18n('L'), left_value: 9, right_name: i18n('R'), right_value: 1,
        })),
      })],
      ['career_path', wlSourceNeedPerKind('career_path'), (i) => ({
        type: 'career_path', clubs: [i18n('a'), i18n('b')],
        display_answer: i18n(`ca${i}`), accepted_answers: [`ca${i}`],
      })],
      ['clue_chain', wlSourceNeedPerKind('who_am_i'), (i) => ({
        type: 'clue_chain', display_answer: i18n(`cl${i}`), accepted_answers: [`cl${i}`],
        clues: [1, 2, 3, 4, 5].map((c) => ({ type: 'text', content: i18n(`c${c}`) })),
      })],
    ];
    for (const [type, need, build] of stock) {
      for (let i = 0; i < need; i += 1) {
        const [q] = await sql<{ id: string }[]>`
          INSERT INTO questions (category_id, type, difficulty, status, ranked_eligible, visibility, prompt)
          VALUES (${categoryId}, ${type}, 'medium', 'published', true, 'wl_private',
                  ${sql.json(i18n(`sp-${type}-${testQuestionIds.length}`) as never)})
          RETURNING id
        `;
        await sql`INSERT INTO question_payloads (question_id, payload) VALUES (${q.id}, ${sql.json(build(i) as never)})`;
        testQuestionIds.push(q.id);
      }
    }

    const SPEC_DELAY = 3_000;
    const now = await wlRedisNowMs();
    const created = await wlOrchestratorRepo.createWithInitialEvent({
      weekKey: null,
      isTest: true,
      config: buildWlConfig({
        launch_edition: true,
        question_time_ms: 1_000,
        dispatch_lead_ms: 0,
        break_ms: 2_000,
        checkin_window_ms: 60_000,
        spectator_delay_ms: SPEC_DELAY,
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

    for (const name of ['wls-a', 'wls-b']) {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO users (nickname, is_ai, is_seed, coins, onboarding_complete)
        VALUES (${`${name}-${now}`}, false, false, 0, true) RETURNING id
      `;
      testUserIds.push(u.id);
      await sql`
        INSERT INTO wl_entries (tournament_id, user_id, checked_in_at)
        VALUES (${tid}, ${u.id}, NOW())
      `;
    }

    // Run ~12s of live play + drains: enough for several dispatapós/reveals
    // AND their delayed spectator replays.
    const until = Date.now() + 12_000;
    while (Date.now() < until) {
      await wlOrchestratorTick(fakeIo);
      await new Promise((r) => setTimeout(r, 120));
    }

    const liveBySeq = new Map<number, Emitted>();
    for (const e of emitted) {
      if (e.room === `wl:${tid}` && typeof e.payload['seq'] === 'number') {
        if (!liveBySeq.has(e.payload['seq'] as number)) liveBySeq.set(e.payload['seq'] as number, e);
      }
    }
    const spec = emitted.filter((e) => e.room === `wl:${tid}:spec`);
    expect(spec.length).toBeGreaterThanOrEqual(3);

    // 1) Delay invariant: every spectator emission trails ITS live emission
    //    by at least the configured delay (small scheduling slack allowed).
    for (const s of spec) {
      const seq = s.payload['seq'] as number;
      const live = liveBySeq.get(seq);
      expect(live, `live emission for spec seq ${seq}`).toBeTruthy();
      expect(s.atMs - live!.atMs).toBeGreaterThanOrEqual(SPEC_DELAY - 250);
    }

    // 2) GAPLESS: the spectator stream is exactly the contiguous prefix of
    //    the live stream — every seq equals its predecessor plus one, and
    //    matches the live seqs in order.
    const specSeqs = spec.map((s) => s.payload['seq'] as number);
    for (let i = 1; i < specSeqs.length; i += 1) {
      expect(specSeqs[i]).toBe(specSeqs[i - 1]! + 1);
    }
    // The spectator stream IS the live prefix: it starts at the very first
    // live seq and matches element-for-element.
    const liveSeqsSorted = [...liveBySeq.keys()].sort((a, b) => a - b);
    expect(specSeqs[0]).toBe(liveSeqsSorted[0]);
    expect(specSeqs).toEqual(liveSeqsSorted.slice(0, specSeqs.length));
    const t = await wlOrchestratorRepo.getById(tid);
    expect(Number(t?.spec_delivered_seq)).toBe(specSeqs.at(-1));

    // 3) Self-contained delayed dispatches: the replayed payload carries the
    //    persisted timing stamps players saw.
    const specDispatch = spec.find((s) => s.event === 'wl:dispatch');
    expect(specDispatch).toBeTruthy();
    expect(typeof specDispatch!.payload['playableAt']).toBe('number');
    expect(typeof specDispatch!.payload['deadlineAt']).toBe('number');
    expect(specDispatch!.payload['spectator']).toBe(true);
    // The replayed stamps are EXACTLY what the players saw.
    const liveTwin = liveBySeq.get(specDispatch!.payload['seq'] as number)!;
    expect(specDispatch!.payload['playableAt']).toBe(liveTwin.payload['playableAt']);
    expect(specDispatch!.payload['deadlineAt']).toBe(liveTwin.payload['deadlineAt']);
  }, 120_000);
});
