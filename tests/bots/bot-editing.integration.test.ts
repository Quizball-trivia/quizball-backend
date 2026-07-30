/**
 * Per-bot admin edit — integration tests against the loopback test DB.
 *
 * Covers what the schema layer structurally cannot:
 *   1. THE RP CEILING RAIL — rejection depends on the LIVE human #10, which
 *      only exists in the DB.
 *   2. NICKNAME UNIQUENESS — the case-insensitive partial unique index.
 *   3. THE HISTORY ROW — written changed_by='admin', counted=false, and
 *      publicly visible anyway (the bot-scoped visibility relaxation).
 *   4. QUOTA NOT CONSUMED — the whole point of counted=false.
 *   5. TIER RECOMPUTE + the audit trail.
 *   6. THE DB RAIL LAYER — base_skill CHECK holds if zod were bypassed.
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/bots/bot-editing.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let tuningRepo: typeof import('../../src/modules/bots/tuning/tuning.repo.js').tuningRepo;
let usersRepo: typeof import('../../src/modules/users/users.repo.js').usersRepo;
let rankedRepo: typeof import('../../src/modules/ranked/ranked.repo.js').rankedRepo;
let tierFromRp: typeof import('../../src/modules/ranked/season-rp-formula.js').tierFromRp;
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
    VALUES (${user.id}, ${opts.rp ?? 1200}, 'Bench', 'placed')
    ON CONFLICT (user_id) DO UPDATE SET rp = EXCLUDED.rp
  `;
  return user.id;
}

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

beforeAll(async () => {
  try {
    ({ sql } = await import('../../src/db/index.js'));
    ({ tuningRepo } = await import('../../src/modules/bots/tuning/tuning.repo.js'));
    ({ usersRepo } = await import('../../src/modules/users/users.repo.js'));
    ({ rankedRepo } = await import('../../src/modules/ranked/ranked.repo.js'));
    ({ tierFromRp } = await import('../../src/modules/ranked/season-rp-formula.js'));
    await sql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
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

describe('getEditableBot is scoped to roster bots', () => {
  it('returns the current values for a persistent bot', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`edit-read-${uniq()}`, { rp: 1500, baseSkill: 0.42, dailyCap: 7 });
    const state = await tuningRepo.getEditableBot(botId);
    expect(state).not.toBeNull();
    expect(state!.rp).toBe(1500);
    expect(state!.baseSkill).toBeCloseTo(0.42, 5);
    expect(state!.dailyCap).toBe(7);
  });

  it('returns NULL for a HUMAN user id — the endpoint must never edit real players', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const humanId = await seedHuman(`edit-human-${uniq()}`, 3000);
    expect(await tuningRepo.getEditableBot(humanId)).toBeNull();
  });
});

describe('nickname edit: uniqueness and the history row', () => {
  it('a nickname already held by another user collides (case-insensitively)', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const taken = `Collide${uniq()}`;
    await seedBot(taken);
    const botId = await seedBot(`edit-collide-${uniq()}`);
    expect(await usersRepo.isNicknameTaken(taken, botId)).toBe(true);
    expect(await usersRepo.isNicknameTaken(taken.toUpperCase(), botId)).toBe(true);
    expect(await usersRepo.isNicknameTaken(taken.toLowerCase(), botId)).toBe(true);
  });

  it('the bot may keep its OWN name (excludeUserId)', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const own = `Own${uniq()}`;
    const botId = await seedBot(own);
    expect(await usersRepo.isNicknameTaken(own, botId)).toBe(false);
  });

  it('writes changed_by=admin / counted=false and does NOT consume quota', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const oldName = `Before${uniq()}`;
    const newName = `After${uniq()}`;
    const botId = await seedBot(oldName);

    const quotaBefore = await usersRepo.getNicknameQuota(botId);
    const updated = await usersRepo.changeNicknameInTx({
      userId: botId,
      oldNickname: oldName,
      newNickname: newName,
      changedBy: 'admin',
      counted: false,
    });
    expect(updated?.nickname).toBe(newName);

    const [row] = await sql<{ changed_by: string; counted: boolean; old_nickname: string }[]>`
      SELECT changed_by, counted, old_nickname FROM nickname_history
      WHERE user_id = ${botId} ORDER BY changed_at DESC LIMIT 1
    `;
    expect(row.changed_by).toBe('admin');
    expect(row.counted).toBe(false);
    expect(row.old_nickname).toBe(oldName);

    // The quota is a COUNT of counted rows — an admin edit must not move it.
    const quotaAfter = await usersRepo.getNicknameQuota(botId);
    expect(quotaAfter.countedChanges).toBe(quotaBefore.countedChanges);
    expect(quotaAfter.nextChangeAt).toBeNull();
  });

  it('the admin rename IS publicly visible for a BOT despite counted=false', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const oldName = `PubBot${uniq()}`;
    const botId = await seedBot(oldName);
    await usersRepo.changeNicknameInTx({
      userId: botId,
      oldNickname: oldName,
      newNickname: `PubBotNew${uniq()}`,
      changedBy: 'admin',
      counted: false,
    });
    const history = await usersRepo.getPublicNicknameHistory(botId);
    expect(history.map((h) => h.nickname)).toContain(oldName);
  });

  it('an admin rename of a HUMAN stays HIDDEN (pre-existing behaviour unchanged)', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const oldName = `PubHuman${uniq()}`;
    const humanId = await seedHuman(oldName, 2000);
    await usersRepo.changeNicknameInTx({
      userId: humanId,
      oldNickname: oldName,
      newNickname: `PubHumanNew${uniq()}`,
      changedBy: 'admin',
      counted: false,
    });
    const history = await usersRepo.getPublicNicknameHistory(humanId);
    expect(history.map((h) => h.nickname)).not.toContain(oldName);
  });
});

describe('RP edit: tier recompute', () => {
  it('setRankPoints stores the recomputed tier', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`edit-tier-${uniq()}`, { rp: 500 });
    const newRp = 3100;
    const tier = tierFromRp(newRp);
    expect(tier).toBe('Key Player');

    const applied = await rankedRepo.setRankPoints(botId, newRp, tier);
    expect(applied).toBe(newRp);

    const [row] = await sql<{ rp: number; tier: string }[]>`
      SELECT rp, tier FROM ranked_profiles WHERE user_id = ${botId}
    `;
    expect(Number(row.rp)).toBe(newRp);
    expect(row.tier).toBe('Key Player');
  });

  it('does NOT write a ranked_rp_changes ledger row (admin edits are not match-derived)', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`edit-noledger-${uniq()}`, { rp: 800 });
    await rankedRepo.setRankPoints(botId, 1400, tierFromRp(1400));
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM ranked_rp_changes WHERE user_id = ${botId}
    `;
    expect(count).toBe(0);
  });
});

describe('the RP ceiling rail derives from the live human top 10', () => {
  it('getHumanTop10Rp ignores bots, so a bot cannot raise its own ceiling', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const { governorRepo } = await import('../../src/modules/bots/governor/governor.repo.js');
    const baseline = await governorRepo.getHumanTop10Rp();

    // A bot at absurd RP must not move the human-derived threshold.
    await seedBot(`edit-ceilbot-${uniq()}`, { rp: 99000 });
    expect(await governorRepo.getHumanTop10Rp()).toBe(baseline);
  });
});

describe('audit trail', () => {
  it('records one before->after row per changed field, grouped by request_id', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`edit-audit-${uniq()}`, { rp: 1000, dailyCap: 8 });
    const requestId = crypto.randomUUID();
    await tuningRepo.recordAdminEdits(
      [
        { botUserId: botId, field: 'rp', oldValue: '1000', newValue: '1200' },
        { botUserId: botId, field: 'daily_cap', oldValue: '8', newValue: '4' },
      ],
      requestId,
      'nerfing an overperformer',
    );

    const edits = await tuningRepo.listAdminEdits(botId);
    expect(edits).toHaveLength(2);
    expect(edits.every((e) => e.note === 'nerfing an overperformer')).toBe(true);
    expect(edits.every((e) => e.actor === 'ops-token')).toBe(true);
    const rp = edits.find((e) => e.field === 'rp')!;
    expect(rp.oldValue).toBe('1000');
    expect(rp.newValue).toBe('1200');
  });

  it('REJECTS an empty note at the DB layer too', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`edit-emptynote-${uniq()}`);
    await expect(
      tuningRepo.recordAdminEdits(
        [{ botUserId: botId, field: 'daily_cap', oldValue: '8', newValue: '4' }],
        crypto.randomUUID(),
        '   ',
      ),
    ).rejects.toThrow();
  });

  it('REJECTS an unknown field name at the DB layer', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`edit-badfield-${uniq()}`);
    await expect(
      sql`
        INSERT INTO bot_admin_edits (bot_user_id, field, old_value, new_value, request_id, note)
        VALUES (${botId}, 'governor_adjustment', '0', '-0.5', ${crypto.randomUUID()}, 'nope')
      `,
    ).rejects.toThrow();
  });
});

describe('the DB rail layer holds if zod is bypassed', () => {
  it('REJECTS a base_skill above the band ceiling via raw SQL', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`edit-dbrail-${uniq()}`);
    await expect(
      sql`UPDATE synthetic_player_profiles SET base_skill = 3.5 WHERE user_id = ${botId}`,
    ).rejects.toThrow();
  });

  it('REJECTS a daily_cap above the hard rail via raw SQL', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`edit-capfail-${uniq()}`);
    await expect(
      sql`UPDATE synthetic_player_profiles SET daily_cap = 40 WHERE user_id = ${botId}`,
    ).rejects.toThrow();
  });

  it('ACCEPTS in-band updates through the repo', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`edit-ok-${uniq()}`, { baseSkill: 0.5, dailyCap: 8 });
    await tuningRepo.updateProfileFields(botId, { baseSkill: 0.31, dailyCap: 3 });
    const state = await tuningRepo.getEditableBot(botId);
    expect(state!.baseSkill).toBeCloseTo(0.31, 5);
    expect(state!.dailyCap).toBe(3);
  });
});
