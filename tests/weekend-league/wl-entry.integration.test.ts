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
      ${sql.json({ launch_edition: opts.launchEdition ?? false, qp_target: opts.qpTarget ?? 200 })},
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
  await sql`
    INSERT INTO wl_qp (week_key, user_id, points, wins, losses)
    VALUES (${weekKey}::date, ${userId}, ${points}, 0, 0)
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
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testTournamentIds.length > 0) {
    await sql`DELETE FROM wl_entries WHERE tournament_id = ANY(${sql.array(testTournamentIds)}::uuid[])`;
    await sql`DELETE FROM wl_tournaments WHERE id = ANY(${sql.array(testTournamentIds)}::uuid[])`;
  }
  if (testUserIds.length > 0) {
    await sql`DELETE FROM wl_qp WHERE user_id = ANY(${sql.array(testUserIds)}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${sql.array(testUserIds)}::uuid[])`;
  }
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

  it('admits entry at/above the QP target and snapshots qp_at_entry', async ({ skip }) => {
    if (!dbAvailable) skip();
    const user = await seedUser(`wle-d-${Date.now()}`);
    const tid = await seedTournament({ launchEdition: false, qpTarget: 200, weekKey: '2026-09-12' });
    await seedQp('2026-09-12', user, 235);

    const result = await weekendLeagueService.enter(user);
    expect(result.entered).toBe(true);

    const entry = await weekendLeagueRepo.getEntry(tid, user);
    expect(entry?.qp_at_entry).toBe(235);
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
