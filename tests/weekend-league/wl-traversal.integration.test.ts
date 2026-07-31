/**
 * Full lifecycle traversal against the real DB + Redis: a backdated test
 * tournament cascades through every phase in a handful of orchestrator
 * ticks, with the stub engine standing in for gameplay. Asserts phase
 * progression, in-order outbox delivery to the fake socket server, entry
 * state outcomes, dns_v1 walkover behavior, and the spectator cursor's
 * 30s lag.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let sql: typeof import('../../src/db/index.js').sql;
let repo: typeof import('../../src/modules/weekend-league/wl-orchestrator.repo.js').wlOrchestratorRepo;
let tick: typeof import('../../src/modules/weekend-league/wl-orchestrator.js').wlOrchestratorTick;
let buildConfig: typeof import('../../src/modules/weekend-league/wl-config.js').buildWlConfig;
let available = false;


// Cross-worker mutex: tournament-facing integration files act on the global
// "current tournament", so two files running in parallel against the shared
// DB shadow each other. A session-scoped advisory lock on a reserved
// connection serializes them across vitest workers.

async function deleteAutoCreatedRealTournaments(): Promise<void> {
  // The orchestrator's weekly auto-creation plants a REAL tournament during
  // ticks, which then shadows every test tournament (real-first resolution).
  // Local-test-DB only, by construction of tests/setup.ts — hard-guard anyway.
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) return;
  await sql`DELETE FROM wl_tournaments WHERE is_test = false`;
}

const WL_TEST_LOCK = 774431001;
let lockConn: Awaited<ReturnType<typeof sql.reserve>> | null = null;

async function acquireFileLock(): Promise<void> {
  lockConn = await sql.reserve();
  await lockConn`SELECT pg_advisory_lock(${WL_TEST_LOCK})`;
}

async function releaseFileLock(): Promise<void> {
  if (!lockConn) return;
  await lockConn`SELECT pg_advisory_unlock(${WL_TEST_LOCK})`.catch(() => {});
  lockConn.release();
  lockConn = null;
}

const testUserIds: string[] = [];
const testTournamentIds: string[] = [];

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

async function seedUser(nickname: string): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, is_seed, coins, onboarding_complete)
    VALUES (${nickname}, false, false, 0, true) RETURNING id
  `;
  testUserIds.push(u.id);
  return u.id;
}

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    await sql`SELECT 1`;
    const { initRedisClients } = await import('../../src/realtime/redis.js');
    await initRedisClients();
    const { wlRedisNowMs } = await import('../../src/modules/weekend-league/wl-redis.js');
    await wlRedisNowMs();
    repo = (await import('../../src/modules/weekend-league/wl-orchestrator.repo.js')).wlOrchestratorRepo;
    tick = (await import('../../src/modules/weekend-league/wl-orchestrator.js')).wlOrchestratorTick;
    buildConfig = (await import('../../src/modules/weekend-league/wl-config.js')).buildWlConfig;
    await acquireFileLock();
    await deleteAutoCreatedRealTournaments();
    available = true;
  } catch {
    console.warn('\n⚠️  Skipping WL traversal tests: DB or Redis unavailable.\n');
  }
});

afterAll(async () => {
  if (!available) {
    await releaseFileLock();
    return;
  }
  if (testTournamentIds.length > 0) {
    await sql`DELETE FROM notifications WHERE source_event_key LIKE 'wl:%'
      AND (data->>'tournament_id') = ANY(${sql.array(testTournamentIds)})`;
    await sql`DELETE FROM wl_tournaments WHERE id = ANY(${sql.array(testTournamentIds)}::uuid[])`;
  }
  if (testUserIds.length > 0) {
    await sql`DELETE FROM users WHERE id = ANY(${sql.array(testUserIds)}::uuid[])`;
  }
  const { closeRedisClients } = await import('../../src/realtime/redis.js');
  await closeRedisClients().catch(() => {});
  await releaseFileLock();
  await sql.end({ timeout: 5 });
});

async function createBackdatedTournament(now: number): Promise<string> {
  const created = await repo.createWithInitialEvent({
    weekKey: null,
    isTest: true,
    config: buildConfig({ launch_edition: true, checkin_window_ms: 60_000 }),
    entryOpensAt: new Date(now - 3600_000),
    entryClosesAt: new Date(now - 120_000),
    qualifierStartsAt: new Date(now - 30_000),
    finalStartsAt: new Date(now - 1_000),
    redisTimeMs: now,
    status: 'scheduled',
  });
  if (!created) throw new Error('failed to create test tournament');
  testTournamentIds.push(created.id);
  return created.id;
}

async function runTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await tick(fakeIo);
  // Ticks auto-create the weekly real tournament — remove it so it cannot
  // shadow other tests' tournaments (localhost guard inside).
  await deleteAutoCreatedRealTournaments();
}

describe('WL full lifecycle traversal (stub engine)', () => {
  it('cascades a 3-player field to a completed tournament with a champion', async ({ skip }) => {
    if (!available) skip();
    const tid = await createBackdatedTournament(Date.now());
    const users = await Promise.all(['wlt-a', 'wlt-b', 'wlt-c'].map((n) => seedUser(`${n}-${Date.now()}`)));
    // Backdated windows are already shut, so seed entries + check-ins
    // directly (entry SQL is covered by its own tests).
    for (const u of users) {
      await sql`
        INSERT INTO wl_entries (tournament_id, user_id, checked_in_at, final_checked_in_at)
        VALUES (${tid}, ${u}, NOW(), NOW())
      `;
    }

    await runTicks(6);

    const t = await repo.getById(tid);
    expect(t?.status).toBe('completed');
    expect(t?.champion_user_id == null).toBe(false);

    const entries = await sql<{ user_id: string; state: string }[]>`
      SELECT user_id, state FROM wl_entries WHERE tournament_id = ${tid}
    `;
    const states = entries.map((e) => e.state).sort();
    expect(states).toContain('champion');
    // 3-player field, all ≤ 24: everyone is a finalist; one becomes champion.
    expect(states.filter((s) => s === 'finalist' || s === 'champion').length).toBe(3);

    // Outbox: everything delivered, strictly ordered, seq gapless from 1.
    const events = await sql<{ seq_text: string; type: string; delivered: boolean }[]>`
      SELECT seq::text AS seq_text, type, (delivered_at IS NOT NULL) AS delivered
      FROM wl_events WHERE tournament_id = ${tid} ORDER BY wl_events.seq ASC
    `;
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(events.every((e) => e.delivered)).toBe(true);
    expect(events.map((e) => Number(e.seq_text))).toEqual(events.map((_, i) => i + 1));

    // The fake io saw the same events, in seq order, on the players room.
    const roomEvents = emitted.filter((e) => e.room === `wl:${tid}`);
    const seqs = roomEvents.map((e) => e.payload['seq'] as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(roomEvents.some((e) => e.event === 'wl:final_result')).toBe(true);

    // Spectator delivery lags 30s: nothing due yet, cursor still 0.
    const specEvents = emitted.filter((e) => e.room === `wl:${tid}:spec`);
    expect(specEvents.length).toBe(0);
    expect(Number(t?.spec_delivered_seq)).toBe(0);
  });

  it('cancels at kickoff when fewer than 2 checked in, with a wave', async ({ skip }) => {
    if (!available) skip();
    const tid = await createBackdatedTournament(Date.now());
    const lone = await seedUser(`wlt-lone-${Date.now()}`);
    await sql`
      INSERT INTO wl_entries (tournament_id, user_id, checked_in_at)
      VALUES (${tid}, ${lone}, NOW())
    `;

    await runTicks(4);

    const t = await repo.getById(tid);
    expect(t?.status).toBe('cancelled');

    const notes = await sql<{ user_id: string }[]>`
      SELECT user_id FROM notifications
      WHERE source_event_key = ${'wl:' + tid + ':cancelled'}
    `;
    expect(notes.map((n) => n.user_id)).toEqual([lone]);

    // Idempotency: another tick must not duplicate the wave.
    await runTicks(1);
    const notes2 = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM notifications
      WHERE source_event_key = ${'wl:' + tid + ':cancelled'}
    `;
    expect(notes2[0]?.n).toBe(1);
  });

  it('dns_v1 walkover: zero final check-ins completes without a champion... unless one showed', async ({ skip }) => {
    if (!available) skip();
    const tid = await createBackdatedTournament(Date.now());
    const a = await seedUser(`wlt-w-${Date.now()}`);
    const b = await seedUser(`wlt-x-${Date.now()}`);
    // Both check in Saturday; only A checks in for the final.
    await sql`
      INSERT INTO wl_entries (tournament_id, user_id, checked_in_at, final_checked_in_at)
      VALUES (${tid}, ${a}, NOW(), NOW()), (${tid}, ${b}, NOW(), NULL)
    `;

    await runTicks(6);

    const t = await repo.getById(tid);
    expect(t?.status).toBe('completed');
    expect(t?.champion_user_id).toBe(a);

    const rows = await sql<{ user_id: string; state: string }[]>`
      SELECT user_id, state FROM wl_entries WHERE tournament_id = ${tid}
    `;
    const byUser = new Map(rows.map((r) => [r.user_id, r.state]));
    expect(byUser.get(a)).toBe('champion');
    expect(byUser.get(b)).toBe('no_show');
  });
});
