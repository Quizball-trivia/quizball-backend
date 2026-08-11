/**
 * Entry + check-in — the single-conditional-SQL authorization paths against
 * the local DB. Each denial branch is asserted through the service so the
 * classification (reporting) agrees with the SQL (authorization).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let sql: typeof import('../../src/db/index.js').sql;
let weekendLeagueService: typeof import('../../src/modules/weekend-league/index.js').weekendLeagueService;
let weekendLeagueRepo: typeof import('../../src/modules/weekend-league/index.js').weekendLeagueRepo;
let dbAvailable = false;


// Cross-worker mutex: tournament-facing integration files act on the global
// "current tournament", so two files running in parallel against the shared
// DB shadow each other. A session-scoped advisory lock on a reserved
// connection serializes them across vitest workers.

async function deleteAutoCreatedRealTournaments(): Promise<void> {
  // The orchestrator's weekly auto-creation plants a REAL tournament during
  // ticks, which then shadows every test tournament (real-first resolution).
  // Local-test-DB only, by construction of tests/setup.ts — hard-guard anyway.
  try {
    if (!['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)) return;
  } catch { return; }
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

async function seedUser(nickname: string): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, is_seed, coins, onboarding_complete)
    VALUES (${nickname}, false, false, 0, true)
    RETURNING id
  `;
  testUserIds.push(u.id);
  return u.id;
}

interface SeedTournamentOptions {
  status?: string;
  launchEdition?: boolean;
  qpTarget?: number;
  entryClosesInMs?: number;
  qualifierStartsInMs?: number;
  finalStartsInMs?: number;
  weekKey?: string;
}

async function seedTournament(opts: SeedTournamentOptions = {}): Promise<string> {
  const now = Date.now();
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO wl_tournaments (
      week_key, is_test, status, config,
      entry_opens_at, entry_closes_at, qualifier_starts_at, final_starts_at
    )
    VALUES (
      ${opts.weekKey ?? null}, true, ${opts.status ?? 'entry_open'},
      ${sql.json({ launch_edition: opts.launchEdition ?? false, free_entry: opts.launchEdition ?? false, qp_target: opts.qpTarget ?? 200 })},
      ${new Date(now - 60_000)},
      ${new Date(now + (opts.entryClosesInMs ?? 60_000))},
      ${new Date(now + (opts.qualifierStartsInMs ?? 5 * 60_000))},
      ${new Date(now + (opts.finalStartsInMs ?? 60 * 60_000))}
    )
    RETURNING id
  `;
  testTournamentIds.push(t.id);
  return t.id;
}

async function seedQp(weekKey: string, userId: string, points: number): Promise<void> {
  // QP economy v2: entry gates on the AWARD-LEDGER balance, so tests seed
  // award rows (a synthetic match id per row keeps the PK unique).
  await sql`
    INSERT INTO wl_qp_awards (match_id, user_id, week_key, points, result)
    VALUES (gen_random_uuid(), ${userId}, ${weekKey}::date, ${points}, 'win')
  `;
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    const wl = await import('../../src/modules/weekend-league/index.js');
    weekendLeagueService = wl.weekendLeagueService;
    weekendLeagueRepo = wl.weekendLeagueRepo;
    await acquireFileLock();
    await deleteAutoCreatedRealTournaments();
    dbAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping WL entry integration tests: DB unavailable.\n');
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  // Each test seeds its own tournament; terminal-ize earlier ones so
  // getCurrentTournament always resolves to the row under test.
  if (testTournamentIds.length > 0) {
    await sql`
      UPDATE wl_tournaments SET status = 'cancelled'
      WHERE id = ANY(${sql.array(testTournamentIds)}::uuid[])
        AND status NOT IN ('completed', 'cancelled', 'voided')
    `;
  }
}, 120_000);

afterAll(async () => {
  if (!dbAvailable) {
    await releaseFileLock();
    return;
  }
  if (testTournamentIds.length > 0) {
    await sql`DELETE FROM wl_entries WHERE tournament_id = ANY(${sql.array(testTournamentIds)}::uuid[])`;
    await sql`DELETE FROM wl_tournaments WHERE id = ANY(${sql.array(testTournamentIds)}::uuid[])`;
  }
  if (testUserIds.length > 0) {
    await sql`DELETE FROM wl_qp_awards WHERE user_id = ANY(${sql.array(testUserIds)}::uuid[])`;
    await sql`DELETE FROM wl_qp WHERE user_id = ANY(${sql.array(testUserIds)}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${sql.array(testUserIds)}::uuid[])`;
  }
  await releaseFileLock();
  await sql.end({ timeout: 5 });
});

describe('enter', () => {
  it('enters during entry_open under launch edition, idempotently', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wle-a-${Date.now()}`);
    await seedTournament({ launchEdition: true });

    const first = await weekendLeagueService.enter(user);
    expect(first).toEqual({ entered: true, already_entered: false, reason: 'ok' });

    const second = await weekendLeagueService.enter(user);
    expect(second).toEqual({ entered: true, already_entered: true, reason: 'ok' });
  });

  it('rejects entry when the window has closed', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wle-b-${Date.now()}`);
    await seedTournament({ launchEdition: true, entryClosesInMs: -1000 });

    const result = await weekendLeagueService.enter(user);
    expect(result).toEqual({ entered: false, already_entered: false, reason: 'window_closed' });
  });

  it('rejects entry below the QP target when not launch edition', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wle-c-${Date.now()}`);
    await seedTournament({ launchEdition: false, qpTarget: 200, weekKey: '2026-09-05' });
    await seedQp('2026-09-05', user, 150);

    const result = await weekendLeagueService.enter(user);
    expect(result).toEqual({ entered: false, already_entered: false, reason: 'not_qualified' });
  });

  it('admits entry at/above the target, snapshots the balance, and RESETS it', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wle-d-${Date.now()}`);
    const tid = await seedTournament({ launchEdition: false, qpTarget: 200, weekKey: '2026-09-12' });
    await seedQp('2026-09-12', user, 235);

    const before = await weekendLeagueRepo.getQpBalance(user);
    expect(before.balance).toBe(235);

    const result = await weekendLeagueService.enter(user);
    expect(result.entered).toBe(true);

    const entry = await weekendLeagueRepo.getEntry(tid, user);
    expect(entry?.qp_at_entry).toBe(235);

    // The ticket is bought: balance resets to zero, the grind restarts —
    // and NEW awards accrue after the reset.
    const after = await weekendLeagueRepo.getQpBalance(user);
    expect(after.balance).toBe(0);
    await seedQp('2026-09-12', user, 25);
    const regrind = await weekendLeagueRepo.getQpBalance(user);
    expect(regrind.balance).toBe(25);
  });

  it('rejects entry in a non-entry phase', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wle-e-${Date.now()}`);
    await seedTournament({ launchEdition: true, status: 'checkin' });

    const result = await weekendLeagueService.enter(user);
    expect(result.entered).toBe(false);
    expect(result.reason).toBe('window_closed');
  });
});

describe('checkin', () => {
  it('checks in inside the 10-minute window, idempotently', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wlc-a-${Date.now()}`);
    const tid = await seedTournament({
      launchEdition: true,
      status: 'checkin',
      qualifierStartsInMs: 5 * 60_000,
    });
    await sql`INSERT INTO wl_entries (tournament_id, user_id) VALUES (${tid}, ${user})`;

    const first = await weekendLeagueService.checkin(user);
    expect(first).toEqual({ checked_in: true, already_checked_in: false, reason: 'ok' });

    const second = await weekendLeagueService.checkin(user);
    expect(second).toEqual({ checked_in: true, already_checked_in: true, reason: 'ok' });
  });

  it('rejects check-in before the window opens', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wlc-b-${Date.now()}`);
    const tid = await seedTournament({
      launchEdition: true,
      status: 'checkin',
      qualifierStartsInMs: 30 * 60_000,
    });
    await sql`INSERT INTO wl_entries (tournament_id, user_id) VALUES (${tid}, ${user})`;

    const result = await weekendLeagueService.checkin(user);
    expect(result).toEqual({ checked_in: false, already_checked_in: false, reason: 'window_closed' });
  });

  it('rejects check-in without an entry', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wlc-c-${Date.now()}`);
    await seedTournament({ launchEdition: true, status: 'checkin' });

    const result = await weekendLeagueService.checkin(user);
    expect(result).toEqual({ checked_in: false, already_checked_in: false, reason: 'not_entered' });
  });

  it('deleting a tournament cascades through questions, runs and answers', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wld-a-${Date.now()}`);
    const tid = await seedTournament({ launchEdition: true });
    const [q] = await sql<{ question_id: string }[]>`
      INSERT INTO wl_questions (tournament_id, game_index, round_index, question_index, kind, payload, evaluation)
      VALUES (${tid}, 0, 0, 0, 'mcq', '{}'::jsonb, '{}'::jsonb)
      RETURNING question_id
    `;
    const [run] = await sql<{ attempt_id: string }[]>`
      INSERT INTO wl_question_runs (tournament_id, game_index, round_index, question_index, question_id)
      VALUES (${tid}, 0, 0, 0, ${q.question_id})
      RETURNING attempt_id
    `;
    await sql`
      INSERT INTO wl_answers (attempt_id, user_id, tournament_id, game_index, answer, correct, points, elapsed_ms, time_charge_ms, timing_source)
      VALUES (${run.attempt_id}, ${user}, ${tid}, 0, '{}'::jsonb, true, 40, 1200, 1200, 'server')
    `;

    await sql`DELETE FROM wl_tournaments WHERE id = ${tid}`;

    const [counts] = await sql<{ q: number; r: number; a: number }[]>`
      SELECT
        (SELECT COUNT(*) FROM wl_questions WHERE tournament_id = ${tid})::int AS q,
        (SELECT COUNT(*) FROM wl_question_runs WHERE tournament_id = ${tid})::int AS r,
        (SELECT COUNT(*) FROM wl_answers WHERE tournament_id = ${tid})::int AS a
    `;
    expect(counts).toEqual({ q: 0, r: 0, a: 0 });
    // Row is gone — drop it from the teardown list.
    testTournamentIds.splice(testTournamentIds.indexOf(tid), 1);
  });

  it('final check-in requires finalist state', async ({ skip }) => {
    if (!dbAvailable) skip();
    const finalist = await seedUser(`wlf-a-${Date.now()}`);
    const eliminated = await seedUser(`wlf-b-${Date.now()}`);
    const tid = await seedTournament({
      launchEdition: true,
      status: 'final_checkin',
      finalStartsInMs: 5 * 60_000,
    });
    await sql`
      INSERT INTO wl_entries (tournament_id, user_id, state)
      VALUES (${tid}, ${finalist}, 'finalist'), (${tid}, ${eliminated}, 'eliminated')
    `;

    const ok = await weekendLeagueService.checkin(finalist);
    expect(ok).toEqual({ checked_in: true, already_checked_in: false, reason: 'ok' });

    const denied = await weekendLeagueService.checkin(eliminated);
    expect(denied).toEqual({ checked_in: false, already_checked_in: false, reason: 'not_finalist' });
  });
});

describe('late join', () => {
  async function entryOf(tid: string, uid: string) {
    const [e] = await sql<Array<{ state: string; checked_in_at: string | null; final_checked_in_at: string | null }>>`
      SELECT state, checked_in_at::text, final_checked_in_at::text
      FROM wl_entries WHERE tournament_id = ${tid} AND user_id = ${uid}
    `;
    return e;
  }

  async function participant(tid: string, uid: string, game: number): Promise<boolean> {
    const rows = await sql`
      SELECT 1 FROM wl_game_participants
      WHERE tournament_id = ${tid} AND user_id = ${uid} AND game_index = ${game}
    `;
    return rows.length > 0;
  }

  it('joins a live game 0 inside the grace window and becomes a participant', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wlj-a-${Date.now()}`);
    const tid = await seedTournament({ status: 'game_live', qualifierStartsInMs: -60_000 });
    await sql`INSERT INTO wl_entries (tournament_id, user_id, state) VALUES (${tid}, ${user}, 'entered')`;

    const res = await weekendLeagueService.checkin(user);
    expect(res).toEqual({ checked_in: true, already_checked_in: false, reason: 'ok' });
    const e = await entryOf(tid, user);
    expect(e?.state).toBe('playing');
    expect(e?.checked_in_at).not.toBeNull();
    expect(await participant(tid, user, 0)).toBe(true);
  });

  it('rejects a qualifier join after the grace deadline', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wlj-b-${Date.now()}`);
    const tid = await seedTournament({ status: 'game_live', qualifierStartsInMs: -200_000 });
    await sql`INSERT INTO wl_entries (tournament_id, user_id, state) VALUES (${tid}, ${user}, 'entered')`;

    const res = await weekendLeagueService.checkin(user);
    expect(res.checked_in).toBe(false);
    expect((await entryOf(tid, user))?.state).toBe('entered');
  });

  it('rejects a late join once the gauntlet moved past game 0', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wlj-c-${Date.now()}`);
    const tid = await seedTournament({ status: 'game_live', qualifierStartsInMs: -60_000 });
    await sql`UPDATE wl_tournaments SET stage = '{"current_game": 1}'::jsonb WHERE id = ${tid}`;
    await sql`INSERT INTO wl_entries (tournament_id, user_id, state) VALUES (${tid}, ${user}, 'entered')`;

    const res = await weekendLeagueService.checkin(user);
    expect(res.checked_in).toBe(false);
  });

  it('reverts a marked no_show into the live final within grace', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wlj-d-${Date.now()}`);
    const tid = await seedTournament({ status: 'final_live', finalStartsInMs: -60_000 });
    await sql`INSERT INTO wl_entries (tournament_id, user_id, state) VALUES (${tid}, ${user}, 'no_show')`;

    const res = await weekendLeagueService.checkin(user);
    expect(res).toEqual({ checked_in: true, already_checked_in: false, reason: 'ok' });
    const e = await entryOf(tid, user);
    expect(e?.state).toBe('finalist');
    expect(e?.final_checked_in_at).not.toBeNull();
    expect(await participant(tid, user, 3)).toBe(true);
  });

  it('checks a finalist into a held (past-start) final_checkin without seating them', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wlj-e-${Date.now()}`);
    const tid = await seedTournament({ status: 'final_checkin', finalStartsInMs: -30_000 });
    await sql`INSERT INTO wl_entries (tournament_id, user_id, state) VALUES (${tid}, ${user}, 'finalist')`;

    const res = await weekendLeagueService.checkin(user);
    expect(res).toEqual({ checked_in: true, already_checked_in: false, reason: 'ok' });
    const e = await entryOf(tid, user);
    expect(e?.state).toBe('finalist');
    expect(e?.final_checked_in_at).not.toBeNull();
    expect(await participant(tid, user, 3)).toBe(false);
  });
});
