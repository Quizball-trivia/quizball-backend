/**
 * Two-process harness: two REAL node processes race the same tournament
 * through the orchestrator while the parent SIGKILLs one mid-flight. Proves
 * the distributed claims that in-process tests cannot: the orchestrator
 * lock, outbox lease fencing and CAS transitions hold under genuine
 * cross-process contention and an ungraceful death, ending in a completed
 * tournament with gapless, exactly-once-delivered events.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { WL_EVENT_POISON_ATTEMPTS } from '../../src/modules/weekend-league/wl-events.repo.js';

let sql: typeof import('../../src/db/index.js').sql;
let repo: typeof import('../../src/modules/weekend-league/wl-orchestrator.repo.js').wlOrchestratorRepo;
let buildConfig: typeof import('../../src/modules/weekend-league/wl-config.js').buildWlConfig;
let available = false;

const testUserIds: string[] = [];
const testTournamentIds: string[] = [];

const WL_TEST_LOCK = 774431001;
let lockConn: Awaited<ReturnType<typeof sql.reserve>> | null = null;

async function deleteAutoCreatedRealTournaments(): Promise<void> {
  try {
    if (!['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)) return;
  } catch { return; }
  await sql`DELETE FROM wl_tournaments WHERE is_test = false`;
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
    buildConfig = (await import('../../src/modules/weekend-league/wl-config.js')).buildWlConfig;
    lockConn = await sql.reserve();
    await lockConn`SELECT pg_advisory_lock(${WL_TEST_LOCK})`;
    await deleteAutoCreatedRealTournaments();
    available = true;
  } catch {
    console.warn('\n⚠️  Skipping WL two-process tests: DB or Redis unavailable.\n');
  }
}, 120_000);

afterAll(async () => {
  if (!available) {
    if (lockConn) {
      await lockConn`SELECT pg_advisory_unlock(${WL_TEST_LOCK})`.catch(() => {});
      lockConn.release();
    }
    return;
  }
  await deleteAutoCreatedRealTournaments();
  if (testTournamentIds.length > 0) {
    await sql`DELETE FROM wl_tournaments WHERE id = ANY(${sql.array(testTournamentIds)}::uuid[])`;
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

function spawnTicker(iterations: number, intervalMs: number): ChildProcess {
  const tsx = path.resolve('node_modules/.bin/tsx');
  const script = path.resolve('tests/weekend-league/helpers/wl-ticker-child.ts');
  return spawn(tsx, [script, String(iterations), String(intervalMs)], {
    env: {
      ...process.env,
      NODE_ENV: 'local',
      LOG_LEVEL: 'silent',
      DATABASE_URL: process.env.DATABASE_URL,
      SUPABASE_URL: process.env.SUPABASE_URL ?? 'https://test.supabase.co',
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? 'test-anon-key',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

describe('WL two-process orchestration', () => {
  it('two racing tickers + one SIGKILL still complete the tournament exactly once', async ({ skip }) => {
    if (!available) skip();

    const { wlRedisNowMs } = await import('../../src/modules/weekend-league/wl-redis.js');
    const now = await wlRedisNowMs();
    const created = await repo.createWithInitialEvent({
      weekKey: null,
      isTest: true,
      config: buildConfig({ launch_edition: true, free_entry: true, checkin_window_ms: 60_000, engine: 'stub' }),
      entryOpensAt: new Date(now - 3600_000),
      entryClosesAt: new Date(now - 120_000),
      qualifierStartsAt: new Date(now - 30_000),
      finalStartsAt: new Date(now - 1_000),
      redisTimeMs: now,
      status: 'scheduled',
    });
    if (!created) throw new Error('create failed');
    testTournamentIds.push(created.id);

    for (const name of ['wl2p-a', 'wl2p-b', 'wl2p-c']) {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO users (nickname, is_ai, is_seed, coins, onboarding_complete)
        VALUES (${`${name}-${now}`}, false, false, 0, true) RETURNING id
      `;
      testUserIds.push(u.id);
      await sql`
        INSERT INTO wl_entries (tournament_id, user_id, checked_in_at, final_checked_in_at)
        VALUES (${created.id}, ${u.id}, NOW(), NOW())
      `;
    }

    const childA = spawnTicker(300, 100);
    const childB = spawnTicker(300, 100);
    // Ungraceful death mid-run: B dies, A must finish the job alone.
    setTimeout(() => childB.kill('SIGKILL'), 700);

    // Poll for completion rather than waiting for the full child runtime.
    const deadline = Date.now() + 45_000;
    let status = '';
    while (Date.now() < deadline) {
      const t = await repo.getById(created.id);
      status = t?.status ?? '';
      if (status === 'completed') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    childA.kill('SIGKILL');
    await Promise.all([waitForExit(childA), waitForExit(childB)]);

    expect(status).toBe('completed');
    const t = await repo.getById(created.id);
    expect(t?.champion_user_id == null).toBe(false);

    const events = await sql<{ seq_text: string; delivered: boolean; attempts: number }[]>`
      SELECT seq::text AS seq_text, (delivered_at IS NOT NULL) AS delivered, attempts
      FROM wl_events WHERE tournament_id = ${created.id} ORDER BY wl_events.seq ASC
    `;
    // Gapless from 1, every event delivered under a fence, no runaway retries.
    expect(events.map((e) => Number(e.seq_text))).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.delivered)).toBe(true);
    expect(events.every((e) => e.attempts < WL_EVENT_POISON_ATTEMPTS)).toBe(true);
  }, 60_000);
});
