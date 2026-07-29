/**
 * PR10 integration tests against the real test DB.
 *
 * Covers the three things the unit tests structurally cannot:
 *   1. FREEZE EXCLUDES FROM SELECTION — the freeze must be enforced in the
 *      eligibility SQL, not just stored. A mocked repo would happily "pass" a
 *      freeze that the query ignores.
 *   2. PARAMS REFRESH PROPAGATION — a write followed by a cache invalidation is
 *      visible to the next read (the no-redeploy guarantee).
 *   3. THE DB RAIL LAYER — the migration's CHECK constraints reject an
 *      out-of-rail value even if the zod layer were bypassed.
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/bots/tuning-freeze.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let syntheticBotsRepo: typeof import('../../src/modules/synthetic-bots/synthetic-bots.repo.js').syntheticBotsRepo;
let tuningRepo: typeof import('../../src/modules/bots/tuning/tuning.repo.js').tuningRepo;
let dbAvailable = false;

const testUserIds: string[] = [];

async function seedBot(nickname: string, opts: { frozen?: boolean; rp?: number } = {}): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, onboarding_complete)
    VALUES (${nickname}, true, 'persistent', true)
    RETURNING id
  `;
  testUserIds.push(user.id);
  await sql`
    INSERT INTO synthetic_player_profiles
      (user_id, base_skill, personality_seed, status, daily_cap, selection_frozen)
    VALUES (${user.id}, 0.5, 4242, 'active', 8, ${opts.frozen ?? false})
  `;
  await sql`
    INSERT INTO ranked_profiles (user_id, rp, tier, placement_status)
    VALUES (${user.id}, ${opts.rp ?? 1200}, 'bronze', 'placed')
    ON CONFLICT (user_id) DO UPDATE SET rp = EXCLUDED.rp
  `;
  return user.id;
}

beforeAll(async () => {
  try {
    ({ sql } = await import('../../src/db/index.js'));
    ({ syntheticBotsRepo } = await import('../../src/modules/synthetic-bots/synthetic-bots.repo.js'));
    ({ tuningRepo } = await import('../../src/modules/bots/tuning/tuning.repo.js'));
    await sql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testUserIds.length > 0) {
    await sql`DELETE FROM synthetic_player_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
  // Leave the singleton in its default (all-null) state for other suites.
  await sql`
    UPDATE bot_tuning_overrides
      SET ceiling_margin = NULL, governor_step = NULL, activity_scale = NULL,
          max_daily_cap = NULL, top_band_target_winrate = NULL,
          mid_ladder_target_winrate = NULL, top_protection_step = NULL,
          top_protection_margin_rp = NULL, top_protection_critical_rp = NULL
    WHERE id = true
  `;
  await sql.end({ timeout: 5 });
});

describe('PR10 freeze excludes a bot from live selection', () => {
  it('an UNFROZEN active bot is eligible', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`pr10-unfrozen-${Date.now()}`);
    const eligible = await syntheticBotsRepo.listEligibleBots();
    expect(eligible.map((b) => b.user_id)).toContain(botId);
  });

  it('a FROZEN bot is NOT eligible', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`pr10-frozen-${Date.now()}`, { frozen: true });
    const eligible = await syntheticBotsRepo.listEligibleBots();
    expect(eligible.map((b) => b.user_id)).not.toContain(botId);
  });

  it('freezing then unfreezing round-trips eligibility', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`pr10-roundtrip-${Date.now()}`);

    await tuningRepo.setSelectionFrozen(botId, true);
    let eligible = await syntheticBotsRepo.listEligibleBots();
    expect(eligible.map((b) => b.user_id)).not.toContain(botId);

    await tuningRepo.setSelectionFrozen(botId, false);
    eligible = await syntheticBotsRepo.listEligibleBots();
    expect(eligible.map((b) => b.user_id)).toContain(botId);
  });

  it('freezing an unknown id returns null so the API can 404', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const result = await tuningRepo.setSelectionFrozen(
      '00000000-0000-0000-0000-000000000000',
      true,
    );
    expect(result).toBeNull();
  });
});

describe('PR10 overrides propagation + DB rail layer', () => {
  it('a write is visible to the next read and bumps the version', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const before = await tuningRepo.getOverrides();
    const updated = await tuningRepo.updateOverrides({ governorStep: 0.08 }, 'pr10-test');

    expect(updated.governorStep).toBe(0.08);
    // The version bump is what makes a past decision traceable to a config.
    expect(updated.version).toBeGreaterThan(before.version);

    const reread = await tuningRepo.getOverrides();
    expect(reread.governorStep).toBe(0.08);
    expect(reread.updatedBy).toBe('pr10-test');
  });

  it('an explicit null resets the knob back to the code constant', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    await tuningRepo.updateOverrides({ governorStep: 0.06 }, 'pr10-test');
    const cleared = await tuningRepo.updateOverrides({ governorStep: null }, 'pr10-test');
    expect(cleared.governorStep).toBeNull();
  });

  it('a partial update leaves untouched knobs alone', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    await tuningRepo.updateOverrides({ governorStep: 0.08, activityScale: 0.5 }, 'pr10-test');
    const after = await tuningRepo.updateOverrides({ activityScale: 0.8 }, 'pr10-test');
    expect(after.activityScale).toBe(0.8);
    expect(after.governorStep).toBe(0.08);
  });

  it('the DB CHECK rejects an out-of-rail daily cap even bypassing zod', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    await expect(
      sql`UPDATE bot_tuning_overrides SET max_daily_cap = 40 WHERE id = true`,
    ).rejects.toThrow();
  });

  it('the DB CHECK rejects a win-rate target above the FROZEN value, bypassing zod', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    // Directional (Sol P0#1 + P1#8): 0.55 is under the brief's absolute cap but
    // above the frozen 0.50, so the DB layer must reject it too.
    await expect(
      sql`UPDATE bot_tuning_overrides SET mid_ladder_target_winrate = 0.55 WHERE id = true`,
    ).rejects.toThrow();
  });

  it('the DB CHECK rejects NARROWING a protection ring, bypassing zod', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    await expect(
      sql`UPDATE bot_tuning_overrides SET top_protection_margin_rp = 50 WHERE id = true`,
    ).rejects.toThrow();
  });

  it('the DB CHECK rejects INVERTED protection rings', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    await expect(
      sql`UPDATE bot_tuning_overrides
            SET top_protection_margin_rp = 200, top_protection_critical_rp = 500
          WHERE id = true`,
    ).rejects.toThrow();
  });

  it('the DB CHECK rejects an out-of-rail daily_cap on a profile row', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    // Sol P2#10: without this the one-time normalization was a one-shot clean
    // that any later generator run could undo.
    const botId = await seedBot(`pr10-cap-${Date.now()}`);
    await expect(
      sql`UPDATE synthetic_player_profiles SET daily_cap = 40 WHERE user_id = ${botId}`,
    ).rejects.toThrow();
  });

  it('the singleton CHECK forbids a second overrides row', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    await expect(
      sql`INSERT INTO bot_tuning_overrides (id) VALUES (false)`,
    ).rejects.toThrow();
  });
});

describe('PR10 emergency zero-offsets', () => {
  it('clears BOOSTING offsets but PRESERVES the EMA history', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const botId = await seedBot(`pr10-zero-${Date.now()}`);
    await sql`
      UPDATE synthetic_player_profiles
        SET governor_adjustment = 0.4, winrate_ema = 0.31, winrate_samples = 25
      WHERE user_id = ${botId}
    `;

    const cleared = await tuningRepo.zeroGovernorOffsets();
    expect(cleared).toBeGreaterThanOrEqual(1);

    const [row] = await sql<Array<{
      governor_adjustment: number;
      winrate_ema: number | null;
      winrate_samples: number;
      governor_samples_at_adjustment: number;
    }>>`
      SELECT governor_adjustment, winrate_ema, winrate_samples, governor_samples_at_adjustment
      FROM synthetic_player_profiles WHERE user_id = ${botId}
    `;
    expect(Number(row.governor_adjustment)).toBe(0);
    // The observation history must survive so the loop resumes warm.
    expect(Number(row.winrate_ema)).toBeCloseTo(0.31, 5);
    expect(Number(row.winrate_samples)).toBe(25);
    // Cooldown anchor re-stamped so the next match cannot immediately re-step.
    expect(Number(row.governor_samples_at_adjustment)).toBe(25);
  });

  it('PRESERVES a negative (safety-nerf) offset — zeroing it would BUFF the bot', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    // Sol P0#2: a negative offset is top-protection holding a bot away from the
    // human top 10. Clearing it is a roster-wide buff, the be#175 failure mode.
    const botId = await seedBot(`pr10-nerf-${Date.now()}`);
    await sql`
      UPDATE synthetic_player_profiles
        SET governor_adjustment = -0.4, winrate_ema = 0.2, winrate_samples = 30
      WHERE user_id = ${botId}
    `;

    await tuningRepo.zeroGovernorOffsets();

    const [row] = await sql<Array<{ governor_adjustment: number }>>`
      SELECT governor_adjustment FROM synthetic_player_profiles WHERE user_id = ${botId}
    `;
    expect(Number(row.governor_adjustment)).toBeCloseTo(-0.4, 5);
  });

  it('a pure READ does not bump the config version', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    // Sol P1#5: getOverrides used INSERT..ON CONFLICT DO UPDATE, so every cache
    // miss and CMS GET minted a fictitious version, destroying provenance.
    const first = await tuningRepo.getOverrides();
    await tuningRepo.getOverrides();
    const third = await tuningRepo.getOverrides();
    expect(third.version).toBe(first.version);
  });
});
