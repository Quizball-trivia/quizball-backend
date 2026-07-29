/**
 * Per-bot admin edit — TRANSACTIONAL semantics (Sol review findings 1-3).
 *
 * These drive the REAL patchBot controller against the loopback test DB,
 * because every property here is a property of the transaction boundary and a
 * mocked repo would happily "pass" a handler that has none:
 *
 *   1. ATOMICITY — a failure part-way through (taken nickname after a valid
 *      rpSet) must leave NOTHING behind: RP unchanged, no audit rows, no
 *      nickname history. The pre-fix handler committed the RP write and then
 *      threw, producing an untraceable difficulty change.
 *   2. LOCKED rpAdjust — two concurrent +100 adjustments must serialize into
 *      1000->1100 and 1100->1200, not two audits both claiming 1000->1100.
 *   3. UNCACHED RP RAIL — the ceiling is read inside the write transaction, so
 *      a human top-10 that moved within the 60s cache TTL is still respected.
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/bots/bot-editing-atomicity.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

process.env.OPS_REPORT_TOKEN ??= 'test-ops-token';

let sql: typeof import('../../src/db/index.js').sql;
let tuningController: typeof import('../../src/modules/bots/tuning/tuning.controller.js').tuningController;
let tuningRepo: typeof import('../../src/modules/bots/tuning/tuning.repo.js').tuningRepo;
let dbAvailable = false;

const testUserIds: string[] = [];
const uniq = () => Math.random().toString(36).slice(2, 8);

async function seedBot(
  nickname: string,
  opts: { rp?: number; baseSkill?: number; dailyCap?: number } = {},
): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, onboarding_complete)
    VALUES (${nickname}, true, 'persistent', true)
    RETURNING id
  `;
  testUserIds.push(user.id);
  await sql`
    INSERT INTO synthetic_player_profiles
      (user_id, base_skill, personality_seed, status, daily_cap)
    VALUES (${user.id}, ${opts.baseSkill ?? 0.5}, 4242, 'active', ${opts.dailyCap ?? 8})
  `;
  await sql`
    INSERT INTO ranked_profiles (user_id, rp, tier, placement_status)
    VALUES (${user.id}, ${opts.rp ?? 1000}, 'Bench', 'placed')
    ON CONFLICT (user_id) DO UPDATE SET rp = EXCLUDED.rp
  `;
  return user.id;
}

/**
 * A human far above every bot in these tests, so the RP ceiling rail is
 * satisfied and never the reason a patch fails.
 */
async function seedHuman(nickname: string, rp: number): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, onboarding_complete)
    VALUES (${nickname}, false, true)
    RETURNING id
  `;
  testUserIds.push(user.id);
  await sql`
    INSERT INTO ranked_profiles (user_id, rp, tier, placement_status)
    VALUES (${user.id}, ${rp}, 'Captain', 'placed')
    ON CONFLICT (user_id) DO UPDATE SET rp = EXCLUDED.rp
  `;
  return user.id;
}

/** Minimal req/res doubles — the controller only touches these fields. */
function fakeReq(botUserId: string, body: Record<string, unknown>) {
  return {
    headers: { 'x-ops-report-token': process.env.OPS_REPORT_TOKEN },
    validated: { params: { botUserId }, body },
  } as never;
}

function fakeRes() {
  const captured: { body?: Record<string, unknown> } = {};
  const res = { json: (payload: Record<string, unknown>) => { captured.body = payload; } };
  return { res: res as never, captured };
}

async function patch(botUserId: string, body: Record<string, unknown>) {
  const { res, captured } = fakeRes();
  await tuningController.patchBot(fakeReq(botUserId, body), res);
  return captured.body!;
}

const rpOf = async (userId: string): Promise<number> => {
  const [row] = await sql<{ rp: number }[]>`SELECT rp FROM ranked_profiles WHERE user_id = ${userId}`;
  return Number(row.rp);
};

const auditCount = async (userId: string): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM bot_admin_edits WHERE bot_user_id = ${userId}
  `;
  return row.count;
};

beforeAll(async () => {
  try {
    ({ sql } = await import('../../src/db/index.js'));
    ({ tuningController } = await import('../../src/modules/bots/tuning/tuning.controller.js'));
    ({ tuningRepo } = await import('../../src/modules/bots/tuning/tuning.repo.js'));
    await sql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
  // Guardrail: these tests WRITE. Refuse to run against anything but loopback.
  const url = process.env.DATABASE_URL ?? '';
  if (dbAvailable && !/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new Error(`Refusing to run write tests against a non-loopback DB: ${url}`);
  }
  // The rail derives from the TENTH-highest placed human, so one high seed is
  // not enough to control it against a DB that already holds other humans:
  // seed a full block of 10 above everything else.
  if (dbAvailable) {
    for (let i = 0; i < 10; i += 1) await seedHuman(`atomic-human-${uniq()}`, 99000 + i);
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testUserIds.length > 0) {
    await sql`DELETE FROM bot_admin_edits WHERE bot_user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM nickname_history WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM synthetic_player_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
  await sql.end({ timeout: 5 });
});

describe('finding 2: the whole PATCH is atomic', () => {
  it('a taken nickname ROLLS BACK the paired rpSet — no RP change, no audit rows', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const takenName = `AtomicTaken${uniq()}`;
    await seedBot(takenName);
    const botId = await seedBot(`atomic-victim-${uniq()}`, { rp: 1000 });

    // rpSet is valid and applied first; the nickname then collides and throws.
    // Pre-fix, the RP write had already committed on its own statement.
    await expect(patch(botId, { rpSet: 1500, nickname: takenName, note: 'paired edit' }))
      .rejects.toThrow(/already taken/i);

    expect(await rpOf(botId)).toBe(1000);
    expect(await auditCount(botId)).toBe(0);
    const [historyRow] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM nickname_history WHERE user_id = ${botId}
    `;
    expect(historyRow.count).toBe(0);
  });

  it('rolls back the nickname too — a rename must not survive a later failure', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const originalName = `AtomicKeep${uniq()}`;
    const botId = await seedBot(originalName, { rp: 1000 });

    // A base_skill outside the DB CHECK band fails AFTER the rename is applied.
    // The rename runs through changeNicknameInTx, which before this fix opened
    // its OWN connection and would have committed independently.
    await expect(
      patch(botId, { nickname: `AtomicNew${uniq()}`, baseSkill: 5.0, note: 'bad skill' }),
    ).rejects.toThrow();

    const [row] = await sql<{ nickname: string }[]>`SELECT nickname FROM users WHERE id = ${botId}`;
    expect(row.nickname).toBe(originalName);
    expect(await auditCount(botId)).toBe(0);
  });

  it('a fully valid multi-field patch COMMITS everything together', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`atomic-ok-${uniq()}`, { rp: 1000, dailyCap: 8 });
    const newName = `AtomicOk${uniq()}`;

    const body = await patch(botId, { rpSet: 1600, nickname: newName, dailyCap: 3, note: 'all good' });
    expect(body.changed).toBe(true);

    expect(await rpOf(botId)).toBe(1600);
    const state = await tuningRepo.getEditableBot(botId);
    expect(state!.dailyCap).toBe(3);
    expect(state!.nickname).toBe(newName);
    // One audit row per changed field, all under the one request_id.
    const edits = await tuningRepo.listAdminEdits(botId);
    expect(edits.map((e) => e.field).sort()).toEqual(['daily_cap', 'nickname', 'rp']);
  });
});

describe('finding 3: concurrent rpAdjust serializes under the row lock', () => {
  it('two parallel +100 adjusts produce SEQUENTIAL audits, not two identical ones', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`atomic-race-${uniq()}`, { rp: 1000 });

    // A concurrent holder of the ranked_profiles row lock, released only once
    // BOTH patches are in flight. Without this the two patches can quietly run
    // end-to-end one after the other and pass even on unlocked code; holding
    // the lock forces them to genuinely overlap and contend.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = sql.begin(async (tx) => {
      await tx`SELECT user_id FROM ranked_profiles WHERE user_id = ${botId} FOR UPDATE`;
      await gate;
    });

    const patches = Promise.all([
      patch(botId, { rpAdjust: 100, note: 'race a' }),
      patch(botId, { rpAdjust: 100, note: 'race b' }),
    ]);
    // Both are now parked on the row lock; let them proceed together.
    await new Promise((r) => setTimeout(r, 150));
    release();
    await blocker;
    await patches;

    expect(await rpOf(botId)).toBe(1200);

    const rpEdits = (await tuningRepo.listAdminEdits(botId)).filter((e) => e.field === 'rp');
    expect(rpEdits).toHaveLength(2);
    // The audit trail must reconstruct the real path 1000 -> 1100 -> 1200.
    const transitions = rpEdits
      .map((e) => `${e.oldValue}->${e.newValue}`)
      .sort();
    expect(transitions).toEqual(['1000->1100', '1100->1200']);
  });

  it('the before-values chain with no gap or overlap', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`atomic-chain-${uniq()}`, { rp: 2000 });

    await Promise.all([
      patch(botId, { rpAdjust: 50, note: 'chain a' }),
      patch(botId, { rpAdjust: 50, note: 'chain b' }),
      patch(botId, { rpAdjust: 50, note: 'chain c' }),
    ]);

    expect(await rpOf(botId)).toBe(2150);
    const rpEdits = (await tuningRepo.listAdminEdits(botId)).filter((e) => e.field === 'rp');
    const olds = rpEdits.map((e) => Number(e.oldValue)).sort((a, b) => a - b);
    const news = rpEdits.map((e) => Number(e.newValue)).sort((a, b) => a - b);
    expect(olds).toEqual([2000, 2050, 2100]);
    expect(news).toEqual([2050, 2100, 2150]);
  });
});

describe('finding 1: the RP ceiling rail reads committed truth, not the cache', () => {
  /**
   * The cached helper cannot be used to demonstrate staleness here: without a
   * Redis connection getOrLoadJson falls straight through to the live loader,
   * so a TTL-stale read is not reproducible in this harness. Assert the
   * property that actually fixes the finding instead — the rail resolves
   * through the tx-aware repo against committed state, so a RP that a stale
   * cache would have waved through is still rejected.
   */
  it('rejects an RP above the ceiling derived from the CURRENT human top 10', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const { governorRepo } = await import('../../src/modules/bots/governor/governor.repo.js');
    // Derived at runtime, not hardcoded: this suite shares the DB with other
    // fixtures, so the live human #10 is whatever they collectively leave.
    const humanTop10 = (await governorRepo.getHumanTop10Rp())!;
    const ceiling = humanTop10 - 100; // RP_CEILING_MARGIN_BELOW_HUMAN_TOP10

    const botId = await seedBot(`atomic-rail-${uniq()}`, { rp: 100 });
    await expect(patch(botId, { rpSet: ceiling + 1, note: 'above live ceiling' }))
      .rejects.toThrow(/safety ceiling/i);
    // Rejected inside the tx, so the RP write rolled back with it.
    expect(await rpOf(botId)).toBe(100);
    expect(await auditCount(botId)).toBe(0);

    // Exactly AT the ceiling is allowed — the rail rejects only above it.
    const ok = await patch(botId, { rpSet: ceiling, note: 'at live ceiling' });
    expect(ok.changed).toBe(true);
    expect(await rpOf(botId)).toBe(ceiling);
  });

  it('reads the ceiling through the transaction handle (uncached path)', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const { governorRepo } = await import('../../src/modules/bots/governor/governor.repo.js');
    // The tx-aware overload must return the same committed value as the pooled
    // read; this is the call the controller now makes instead of the cache.
    const pooled = await governorRepo.getHumanTop10Rp();
    const inTx = await sql.begin(async (tx) => governorRepo.getHumanTop10Rp(tx));
    expect(inTx).toBe(pooled);
  });
});

describe('finding 4: the range constraints are VALIDATED, so no legacy row survives', () => {
  it('both rails are convalidated — a NOT VALID CHECK would still break routine UPDATEs', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    // The migration clamps out-of-range rows BEFORE constraining, which is what
    // lets these be added VALID. A NOT VALID constraint would leave legacy rows
    // in place that then fail every governor/match-counter UPDATE touching them.
    const rows = await sql<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated FROM pg_constraint
      WHERE conrelid = 'public.synthetic_player_profiles'::regclass
        AND conname IN ('synthetic_profiles_base_skill_band', 'synthetic_profiles_daily_cap_rail')
    `;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.convalidated)).toBe(true);
  });

  it('no roster row sits outside either rail', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM synthetic_player_profiles
      WHERE base_skill < 0.05 OR base_skill > 0.90 OR daily_cap < 0 OR daily_cap > 12
    `;
    expect(row.count).toBe(0);
  });

  it('an UPDATE of an unrelated column on an in-range row still succeeds', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    // The regression the NOT VALID variant would have caused: a legacy row
    // becomes un-updatable, so the governor silently stops writing to that bot.
    const botId = await seedBot(`atomic-govupd-${uniq()}`);
    await expect(
      sql`UPDATE synthetic_player_profiles SET matches_today = matches_today + 1 WHERE user_id = ${botId}`,
    ).resolves.toBeDefined();
  });
});
