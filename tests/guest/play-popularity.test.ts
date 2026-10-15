import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../../src/modules/public/play-popularity.repo.js', () => ({ playPopularityRepo: { load: mocks.load } }));
vi.mock('../../src/core/json-cache.js', () => ({ getOrLoadJson: async (_k: string, _ttl: number, load: () => Promise<unknown>) => load() }));

// Fresh module per test: the service keeps an in-process copy of the last result.
let playPopularityService: typeof import('../../src/modules/public/play-popularity.service.js').playPopularityService;
beforeEach(async () => { vi.clearAllMocks(); vi.resetModules(); ({ playPopularityService } = await import('../../src/modules/public/play-popularity.service.js')); });

describe('play popularity', () => {
  it('gives counts per game and nothing else', async () => {
    mocks.load.mockResolvedValue([{ game: 'minuto', players_7d: 40, players_3d: 12 }, { game: 'daily:trueFalse', players_7d: 9, players_3d: 3 }]);
    const out = await playPopularityService.get();
    expect(out.games).toEqual({ minuto: { players_7d: 40, players_3d: 12 }, 'daily:trueFalse': { players_7d: 9, players_3d: 3 } });
    expect(Object.keys(out).sort()).toEqual(['games', 'generated_at']);
  });

  it('trusts its own copy for five minutes, then serves it while a refresh runs behind', async () => {
    vi.useFakeTimers();
    try {
      mocks.load.mockResolvedValueOnce([{ game: 'minuto', players_7d: 1, players_3d: 1 }]);
      const first = await playPopularityService.get();
      vi.advanceTimersByTime(4 * 60_000);
      await playPopularityService.get();
      expect(mocks.load).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2 * 60_000);
      let finish: (rows: unknown[]) => void = () => undefined;
      mocks.load.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      // The refresh has not answered yet: the caller still gets the copy, at once.
      expect(await playPopularityService.get()).toEqual(first);
      expect(await playPopularityService.get()).toEqual(first);
      expect(mocks.load).toHaveBeenCalledTimes(2);
      finish([{ game: 'minuto', players_7d: 9, players_3d: 4 }]);
      await vi.advanceTimersByTimeAsync(0);
      expect((await playPopularityService.get()).games.minuto).toEqual({ players_7d: 9, players_3d: 4 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last good numbers when a refresh fails, and does not hammer a failing database', async () => {
    vi.useFakeTimers();
    try {
      mocks.load.mockResolvedValueOnce([{ game: 'minuto', players_7d: 40, players_3d: 12 }]);
      const first = await playPopularityService.get();
      vi.advanceTimersByTime(6 * 60_000);
      mocks.load.mockRejectedValue(new Error('db down'));
      for (let i = 0; i < 5; i += 1) {
        expect(await playPopularityService.get()).toEqual(first);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(mocks.load).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(121_000);
      await playPopularityService.get();
      expect(mocks.load).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers with no games when there has never been a good read', async () => {
    mocks.load.mockRejectedValue(new Error('db down'));
    expect(await playPopularityService.get()).toEqual({ generated_at: null, games: {} });
  });
});
