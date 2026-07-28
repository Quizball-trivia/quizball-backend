/**
 * Service-level tests for the governor write path (PR9).
 *
 * Covered:
 *  - the optimistic-concurrency guard passes the READ sample count
 *  - a failing top-10 lookup degrades to "no top-protection", not a throw
 *  - a repo failure is swallowed (settlement must never fail on the governor)
 *  - a bot with no synthetic profile is skipped
 *  - the kill switch drives the stored offset to zero
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// getOrLoadJson passes through to the loader so the cache is transparent here.
vi.mock('../../src/core/json-cache.js', () => ({
  getOrLoadJson: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  deleteJsonCacheKeys: vi.fn(async () => {}),
}));

vi.mock('../../src/modules/bots/governor/governor.repo.ts', () => ({
  governorRepo: {
    getState: vi.fn(),
    saveState: vi.fn(),
    getHumanTop10Rp: vi.fn(),
    getDailyWinrates: vi.fn(),
    getOffsetSummary: vi.fn(),
  },
}));

import { config } from '../../src/core/config.js';
import { governorRepo } from '../../src/modules/bots/governor/governor.repo.js';
import { recordSettledMatch } from '../../src/modules/bots/governor/governor.service.js';
import { MAX_GOVERNOR_ADJUSTMENT } from '../../src/modules/bots/governor/governor-state-machine.js';

const mutableConfig = config as unknown as { BOT_GOVERNOR_ENABLED: boolean };
const repo = governorRepo as unknown as {
  getState: ReturnType<typeof vi.fn>;
  saveState: ReturnType<typeof vi.fn>;
  getHumanTop10Rp: ReturnType<typeof vi.fn>;
};

const BOT = 'bot-uuid';

function storedState(overrides = {}) {
  return {
    adjustment: 0,
    winrateEma: 0.5,
    winrateSamples: 40,
    updatedAt: null,
    samplesAtAdjustment: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mutableConfig.BOT_GOVERNOR_ENABLED = true;
  repo.getState.mockResolvedValue(storedState());
  repo.saveState.mockResolvedValue(true);
  repo.getHumanTop10Rp.mockResolvedValue(4000);
});

describe('recordSettledMatch', () => {
  it('persists with the READ sample count as the optimistic-concurrency guard', async () => {
    await recordSettledMatch({ botUserId: BOT, botRp: 1000, won: true, matchId: 'm1' });
    expect(repo.saveState).toHaveBeenCalledTimes(1);
    const [userId, nextState, expectedSamples] = repo.saveState.mock.calls[0];
    expect(userId).toBe(BOT);
    // Guard is the PRE-update value; the written state is the post-update one.
    expect(expectedSamples).toBe(40);
    expect(nextState.winrateSamples).toBe(41);
  });

  it('skips a persistent bot that has no synthetic profile', async () => {
    repo.getState.mockResolvedValue(null);
    const result = await recordSettledMatch({ botUserId: BOT, botRp: 1000, won: true, matchId: 'm1' });
    expect(result).toBeNull();
    expect(repo.saveState).not.toHaveBeenCalled();
  });

  it('returns null (does not throw) when the write loses a concurrent race', async () => {
    repo.saveState.mockResolvedValue(false);
    await expect(
      recordSettledMatch({ botUserId: BOT, botRp: 1000, won: true, matchId: 'm1' }),
    ).resolves.toBeNull();
  });

  it('swallows a repo failure — settlement must never fail on the governor', async () => {
    repo.getState.mockRejectedValue(new Error('db down'));
    await expect(
      recordSettledMatch({ botUserId: BOT, botRp: 1000, won: true, matchId: 'm1' }),
    ).resolves.toBeNull();
  });

  it('degrades to no-top-protection when the top-10 lookup fails', async () => {
    repo.getHumanTop10Rp.mockRejectedValue(new Error('timeout'));
    // A bot that WOULD be inside the ring if the threshold were known.
    const result = await recordSettledMatch({ botUserId: BOT, botRp: 4000, won: true, matchId: 'm1' });
    expect(result).not.toBeNull();
    expect(result?.trigger).not.toBe('top_protection');
    expect(result?.trigger).not.toBe('top_protection_critical');
    // And it still persisted the EMA sample.
    expect(repo.saveState).toHaveBeenCalledTimes(1);
  });

  it('applies top-protection when the bot is near the human top 10', async () => {
    const result = await recordSettledMatch({ botUserId: BOT, botRp: 4000, won: true, matchId: 'm1' });
    expect(result?.trigger).toBe('top_protection_critical');
    expect(result?.next.adjustment).toBe(-MAX_GOVERNOR_ADJUSTMENT);
  });

  it('kill switch drives a stored offset to zero', async () => {
    mutableConfig.BOT_GOVERNOR_ENABLED = false;
    repo.getState.mockResolvedValue(storedState({ adjustment: -0.4 }));
    const result = await recordSettledMatch({ botUserId: BOT, botRp: 4000, won: true, matchId: 'm1' });
    expect(result?.trigger).toBe('disabled');
    expect(result?.next.adjustment).toBe(0);
    // Even though the bot is deep inside the protection ring.
    expect(repo.saveState.mock.calls[0][1].adjustment).toBe(0);
  });
});
