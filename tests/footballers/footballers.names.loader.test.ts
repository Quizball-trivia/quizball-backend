import { afterEach, describe, expect, it, vi } from 'vitest';

const { newestRelease, universe, installed } = vi.hoisted(() => ({
  newestRelease: vi.fn<() => Promise<string | null>>(),
  universe: vi.fn<(releaseId: string) => Promise<{ named: () => string[] }>>(),
  installed: [] as string[],
}));
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../src/modules/footballers/footballers.repo.js', () => ({ footballersRepo: { newestRelease } }));
vi.mock('../../src/modules/footballers/footballers.service.js', () => ({ footballersService: { universe } }));
vi.mock('../../src/modules/footballers/footballers.names.js', () => ({
  footballerNamesOf: (u: { named: () => string[] }) => ({ holders: u.named }),
  installFootballerNames: (names: { holders: () => string[] }) => { installed.push(names.holders()[0]); },
}));

const { startFootballerNamesLoader, FOOTBALLER_NAMES_REFRESH_MS } = await import('../../src/modules/footballers/footballers.names.loader.js');

afterEach(() => { vi.useRealTimers(); });

describe('footballer names loader', () => {
  it('a stalled load does not block the next refresh, and an older load finishing late never replaces a newer release', async () => {
    vi.useFakeTimers();
    let finishFirst!: () => void;
    newestRelease.mockResolvedValueOnce('r1').mockResolvedValue('r2');
    universe.mockImplementation((id) => (id === 'r1'
      ? new Promise((resolve) => { finishFirst = () => resolve({ named: () => ['r1'] }); })
      : Promise.resolve({ named: () => [id] })));

    startFootballerNamesLoader();
    await vi.advanceTimersByTimeAsync(FOOTBALLER_NAMES_REFRESH_MS);
    expect(installed).toEqual(['r2']);
    finishFirst();
    await vi.advanceTimersByTimeAsync(FOOTBALLER_NAMES_REFRESH_MS);
    expect(installed).toEqual(['r2']);
  });
});
