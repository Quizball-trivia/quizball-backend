/**
 * Roster-bot rename worker (§1.12).
 *
 * Covers: evolution-biased name shape, the real nickname pipeline (counted
 * quota + 30-day cooldown + public history), activity-window respect, organic
 * (non-batched) timing, and the flag-off no-op.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/modules/synthetic-bots/synthetic-bots.repo.js', () => ({
  syntheticBotsRepo: { listRenameCandidates: vi.fn(), renameBotAtomically: vi.fn() },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: { isNicknameTaken: vi.fn(), isNicknameReserved: vi.fn(), changeNicknameInTx: vi.fn() },
  // Re-exported at their real values: the rename worker passes these to the
  // atomic repo call, and the test asserts a bot gets the HUMAN allowance.
  NICKNAME_FREE_CHANGES: 2,
  NICKNAME_COOLDOWN_DAYS: 30,
}));

import {
  buildEvolvedNickname,
  MAX_NICKNAME_LENGTH,
  rngFromKey,
} from '../../src/modules/bots/bot-name-evolution.js';
import {
  BOT_RENAME_HOURLY_BASE_RATE,
  runBotRenameTick,
  shouldRenameThisTick,
  startBotRenameWorker,
  stopBotRenameWorker,
} from '../../src/modules/bots/bot-rename.service.js';
import { config } from '../../src/core/config.js';

const configObj = config as unknown as { PERSISTENT_BOTS_ENABLED: boolean };

/** An always-in-window schedule (00:00-24:00 wraps to "always"). */
const ALWAYS_IN_WINDOW = { startHour: 0, endHour: 24 };
/** A window that excludes the small hours regardless of the test clock. */
const NIGHT_ONLY = { startHour: 3, endHour: 4 };

function candidate(overrides: Partial<{
  user_id: string;
  nickname: string;
  schedule: unknown;
  rename_propensity: number;
  personality_seed: string;
}> = {}) {
  return {
    user_id: 'bot-1',
    nickname: 'Levan14',
    schedule: ALWAYS_IN_WINDOW,
    rename_propensity: 1,
    personality_seed: '12345',
    ...overrides,
  };
}

describe('buildEvolvedNickname', () => {
  it('produces a recognisable evolution, not a new identity', () => {
    const stems = ['Levan14', 'gio_k', 'Vaska', 'kukusha09', 'NIKA'];
    for (const current of stems) {
      const rng = rngFromKey(`t:${current}`);
      for (let attempt = 0; attempt < 6; attempt++) {
        const next = buildEvolvedNickname(rng, current, attempt);
        if (!next) continue;
        expect(next).not.toBe(current);
        // A rename must never emit a bot-tell like "player_00473".
        expect(next).not.toMatch(/^(player|bot|user)[_-]?\d+$/i);
        expect(next.length).toBeGreaterThan(0);
      }
    }
  });

  it('preserves the alphabetic stem for the common digit-churn evolution', () => {
    // Sample many streams; every digit-only mutation must keep the letters.
    let digitChurns = 0;
    for (let i = 0; i < 500; i++) {
      const rng = rngFromKey(`stem:${i}`);
      const next = buildEvolvedNickname(rng, 'Levan14', 0);
      if (!next) continue;
      const letters = (s: string) => s.replace(/[^a-z]/gi, '').toLowerCase();
      if (letters(next) === 'levan') digitChurns++;
    }
    expect(digitChurns).toBeGreaterThan(0);
  });

  it('is deterministic for the same stream and input', () => {
    const a = buildEvolvedNickname(rngFromKey('same'), 'Vaska22', 0);
    const b = buildEvolvedNickname(rngFromKey('same'), 'Vaska22', 0);
    expect(b).toBe(a);
  });

  it('returns null for an empty current name', () => {
    expect(buildEvolvedNickname(rngFromKey('x'), '   ', 0)).toBeNull();
  });

  it('refuses a digits-only handle rather than inventing an identity', () => {
    // "12345" has no alphabetic stem: appending a diminutive would yield
    // "ushka12345" (a different person) and digit churn would yield a bare "4"
    // (the handle gone). Skipping is the only stem-preserving answer.
    for (let i = 0; i < 200; i++) {
      const rng = rngFromKey(`digits:${i}`);
      for (let a = 0; a < 6; a++) {
        expect(buildEvolvedNickname(rng, '12345', a)).toBeNull();
      }
    }
  });

  it('never emits a leading or trailing separator', () => {
    for (const current of ['12345', '_gio', 'gio_', 'a.b', '___']) {
      for (let i = 0; i < 100; i++) {
        const rng = rngFromKey(`sep:${current}:${i}`);
        for (let a = 0; a < 6; a++) {
          const next = buildEvolvedNickname(rng, current, a);
          if (!next) continue;
          expect(next).not.toMatch(/^[_.]/);
          expect(next).not.toMatch(/[_.]$/);
        }
      }
    }
  });

  it('never exceeds the 50-char nickname cap', () => {
    const long = 'A'.repeat(49);
    for (let i = 0; i < 200; i++) {
      const rng = rngFromKey(`len:${i}`);
      for (let a = 0; a < 6; a++) {
        const next = buildEvolvedNickname(rng, long, a);
        if (next) expect(next.length).toBeLessThanOrEqual(MAX_NICKNAME_LENGTH);
      }
    }
  });
});

describe('shouldRenameThisTick', () => {
  const now = new Date('2026-07-29T12:00:00Z');

  it('is stable for the same bot within the same tick bucket', () => {
    const bot = { user_id: 'bot-1', personality_seed: '999', rename_propensity: 1 };
    const first = shouldRenameThisTick(bot, now);
    const second = shouldRenameThisTick(bot, new Date(now.getTime() + 60_000));
    expect(second).toBe(first);
  });

  it('never draws for a zero-propensity bot', () => {
    const bot = { user_id: 'bot-1', personality_seed: '999', rename_propensity: 0 };
    for (let h = 0; h < 2_000; h++) {
      const t = new Date(now.getTime() + h * 60 * 60 * 1000);
      expect(shouldRenameThisTick(bot, t)).toBe(false);
    }
  });

  it('fires rarely enough to trickle, not batch', () => {
    // Across 1,000 bots in one tick, essentially none should fire at the real
    // base rate — renames must never arrive as a visible wave.
    let fired = 0;
    for (let i = 0; i < 1_000; i++) {
      if (shouldRenameThisTick({ user_id: `bot-${i}`, personality_seed: String(i), rename_propensity: 1 }, now)) {
        fired++;
      }
    }
    expect(fired).toBeLessThan(5);
  });

  it('reaches the ~10-15% season target for a propensity-bearing cohort', () => {
    // 1,000 bots x ~1,600 in-window ticks over a season, with the generator's
    // propensity distribution (most bots at 0) applied by the caller. Here we
    // simulate the propensity-1.0 subset and assert the per-bot season odds.
    const seasonTicks = 1_600;
    let renamedBots = 0;
    const cohort = 300;
    for (let i = 0; i < cohort; i++) {
      const bot = { user_id: `season-bot-${i}`, personality_seed: String(i), rename_propensity: 1 };
      for (let t = 0; t < seasonTicks; t++) {
        if (shouldRenameThisTick(bot, new Date(now.getTime() + t * 60 * 60 * 1000))) {
          renamedBots++;
          break;
        }
      }
    }
    const share = renamedBots / cohort;
    // A propensity-1.0 bot should be well short of certain but clearly possible.
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.8);
  });

  it('scales with the base rate', () => {
    const bot = { user_id: 'bot-x', personality_seed: '7', rename_propensity: 1 };
    // Base rate 1 makes the draw certain regardless of the hash value.
    expect(shouldRenameThisTick(bot, now, 1)).toBe(true);
    expect(shouldRenameThisTick(bot, now, 0)).toBe(false);
  });
});

describe('runBotRenameTick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // baseRate: 1 forces the draw so the rest of the pipeline is exercised
  // deterministically. Production always uses BOT_RENAME_HOURLY_BASE_RATE.
  function deps(overrides: Record<string, unknown> = {}) {
    return {
      listRenameCandidates: async () => [candidate()],
      isNicknameTaken: async () => false,
      isNicknameReserved: async () => false,
      renameBot: vi.fn().mockResolvedValue('renamed'),
      now: () => new Date('2026-07-29T12:00:00Z'),
      baseRate: 1,
      ...overrides,
    };
  }

  it('reports a lost race without renaming', async () => {
    // The atomic write re-evaluates the reservation + recency predicates under
    // the users row lock; 'raced' means another replica won or the bot entered
    // a match. Renaming mid-match is the failure mode this prevents.
    const result = await runBotRenameTick(deps({
      renameBot: async () => 'raced',
    }));

    expect(result.raced).toBe(1);
    expect(result.renamed).toBe(0);
  });

  it('skips a bot outside its activity window even when the draw would fire', async () => {
    const renameBot = vi.fn();
    const result = await runBotRenameTick(deps({
      listRenameCandidates: async () => [candidate({ schedule: NIGHT_ONLY })],
      renameBot,
      // 12:00 UTC = 16:00 Tbilisi, outside a 03:00-04:00 window.
      now: () => new Date('2026-07-29T12:00:00Z'),
    }));

    expect(result.outOfWindow).toBe(1);
    expect(result.renamed).toBe(0);
    expect(renameBot).not.toHaveBeenCalled();
  });

  it('renames via the real pipeline with an evolved name', async () => {
    const renameBot = vi.fn().mockResolvedValue('renamed');
    const result = await runBotRenameTick(deps({ renameBot }));

    expect(result.renamed).toBe(1);
    expect(renameBot).toHaveBeenCalledTimes(1);
    const arg = renameBot.mock.calls[0]![0] as {
      userId: string; oldNickname: string | null; newNickname: string;
    };
    expect(arg.userId).toBe('bot-1');
    expect(arg.oldNickname).toBe('Levan14');
    expect(arg.newNickname).not.toBe('Levan14');
    // Evolution, not a new identity: the stem survives, or it is a casing flip.
    expect(arg.newNickname.toLowerCase()).toContain('levan');
  });

  it('renames through the atomic repo path with the HUMAN allowance constants', async () => {
    // Guard against the mock drifting from the real constants: read them from
    // the actual source, so a change to the human allowance fails this test
    // rather than silently letting bots keep the old one.
    const realRepoSource = readFileSync(
      join(__dirname, '../../src/modules/users/users.repo.ts'),
      'utf8'
    );
    expect(realRepoSource).toContain('export const NICKNAME_FREE_CHANGES = 2;');
    expect(realRepoSource).toContain('export const NICKNAME_COOLDOWN_DAYS = 30;');

    const { usersRepo, NICKNAME_FREE_CHANGES, NICKNAME_COOLDOWN_DAYS } = await import(
      '../../src/modules/users/users.repo.js'
    );
    vi.mocked(usersRepo.isNicknameTaken).mockResolvedValue(false);
    vi.mocked(usersRepo.isNicknameReserved).mockResolvedValue(false);

    const { syntheticBotsRepo } = await import('../../src/modules/synthetic-bots/synthetic-bots.repo.js');
    vi.mocked(syntheticBotsRepo.listRenameCandidates).mockResolvedValue([candidate()] as never);
    vi.mocked(syntheticBotsRepo.renameBotAtomically).mockResolvedValue('renamed');

    // No renameBot override: the PRODUCTION dependency runs, so this asserts
    // the real repo arguments.
    const result = await runBotRenameTick({
      now: () => new Date('2026-07-29T12:00:00Z'),
      baseRate: 1,
    });

    expect(result.renamed).toBe(1);
    expect(syntheticBotsRepo.renameBotAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        botUserId: 'bot-1',
        oldNickname: 'Levan14',
        // A bot faces the SAME allowance a human does — these are the constants
        // the human path uses, not bot-specific loosened values.
        freeChanges: NICKNAME_FREE_CHANGES,
        cooldownDays: NICKNAME_COOLDOWN_DAYS,
      })
    );
  });

  it('writes a history row indistinguishable from a human rename', async () => {
    // The atomic repo hardcodes changed_by='user' / counted=true /
    // identity_derived=false, matching users.repo.changeNicknameInTx exactly. A
    // 'system' author would make every bot rename identifiable in the public
    // "previously known as" list.
    const repoSource = readFileSync(
      join(__dirname, '../../src/modules/synthetic-bots/synthetic-bots.repo.ts'),
      'utf8'
    );
    const atomic = repoSource.slice(repoSource.indexOf('async renameBotAtomically'));
    expect(atomic).toContain("SELECT $1, $2, $3, 'user', true, false");
  });

  it('respects a quota/cooldown rejection as gated, never as an error', async () => {
    const result = await runBotRenameTick(deps({
      renameBot: async () => 'quota_gated',
    }));

    expect(result.quotaGated).toBe(1);
    expect(result.renamed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('skips a name that is already taken or reserved', async () => {
    const renameBot = vi.fn();
    const result = await runBotRenameTick(deps({
      isNicknameTaken: async () => true,
      renameBot,
    }));

    expect(result.noCandidateName).toBe(1);
    expect(renameBot).not.toHaveBeenCalled();
  });

  it('honours the vacated-name reservation window', async () => {
    const renameBot = vi.fn();
    const result = await runBotRenameTick(deps({
      isNicknameReserved: async () => true,
      renameBot,
    }));

    expect(result.noCandidateName).toBe(1);
    expect(renameBot).not.toHaveBeenCalled();
  });

  it('never renames a bot with an empty current nickname', async () => {
    const renameBot = vi.fn();
    const result = await runBotRenameTick(deps({
      listRenameCandidates: async () => [candidate({ nickname: '' })],
      renameBot,
    }));
    expect(renameBot).not.toHaveBeenCalled();
    expect(result.renamed).toBe(0);
  });

  it('survives a per-bot failure without aborting the tick', async () => {
    const result = await runBotRenameTick(deps({
      listRenameCandidates: async () => [
        candidate({ user_id: 'bot-a' }),
        candidate({ user_id: 'bot-b' }),
      ],
      isNicknameTaken: async () => {
        throw new Error('db down');
      },
    }));

    expect(result.scanned).toBe(2);
    expect(result.attempted).toBe(2);
    expect(result.failed).toBe(2);
  });
});

describe('rename worker flag gating', () => {
  const original = configObj.PERSISTENT_BOTS_ENABLED;

  afterEach(async () => {
    configObj.PERSISTENT_BOTS_ENABLED = original;
    await stopBotRenameWorker();
  });

  it('does not schedule a timer when PERSISTENT_BOTS_ENABLED is off', async () => {
    configObj.PERSISTENT_BOTS_ENABLED = false;
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    startBotRenameWorker();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});
