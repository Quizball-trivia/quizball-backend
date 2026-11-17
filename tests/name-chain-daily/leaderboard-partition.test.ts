import { describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { buildUniverse } from '../../src/modules/footballers/footballers.universe.js';
import { createNameChainDailyService } from '../../src/modules/name-chain-daily/name-chain-daily.service.js';

const DAY = '2026-10-20';
const universe = buildUniverse('rel-1', [{ pid: 'p-1', name: 'Tarin Orlen', game: 'Orlen', fame: 80, aliases: [] }]);

function make(run: { al?: string } | null, dayHasGreek: boolean) {
  const repo = {
    getRun: vi.fn(async () => (run ? { state: run } : null)),
    commonStateValue: vi.fn(async () => (dayHasGreek ? 'el-1' : null)),
    leaderboard: vi.fn(async () => ({ players: 0, top: [] })),
    rankOf: vi.fn(async () => null),
  };
  const service = createNameChainDailyService({
    repo: repo as never, content: async () => new Map([[DAY, { day: DAY, number: 1, contentVersion: 1, release: 'rel-1', seed: 1, universe }]]),
    contentStale: () => undefined, now: () => new Date(`${DAY}T15:00:00Z`), reports: { file: vi.fn() } as never,
  });
  return { repo, service };
}
const partitions = (repo: ReturnType<typeof make>['repo']) => [repo.leaderboard.mock.calls.at(-1)?.[2], repo.rankOf.mock.calls.at(-1)?.[3]];

describe('which name chain board a Greek player sees', () => {
  it('the board of their own run: a run started without Greek names ranks (and is found) on the Latin board', async () => {
    const latin = make({}, true);
    await latin.service.leaderboard(DAY, 'u-1', 'el');
    expect(partitions(latin.repo)).toEqual(['', '']);
    const greek = make({ al: 'gr' }, false);
    await greek.service.leaderboard(DAY, 'u-1', 'el');
    expect(partitions(greek.repo)).toEqual(['gr', 'gr']);
  });

  it('without a run: the Greek-letter board once the day has Greek-letter runs, else the Latin one', async () => {
    const on = make(null, true);
    await on.service.leaderboard(DAY, null, 'el');
    expect(on.repo.leaderboard.mock.calls.at(-1)?.[2]).toBe('gr');
    const off = make(null, false);
    await off.service.leaderboard(DAY, null, 'el');
    expect(off.repo.leaderboard.mock.calls.at(-1)?.[2]).toBe('');
  });

  it('other languages are unchanged', async () => {
    const ru = make({ al: 'gr' }, true);
    await ru.service.leaderboard(DAY, 'u-1', 'ru');
    expect(partitions(ru.repo)).toEqual(['cy', 'cy']);
    expect(ru.repo.getRun).not.toHaveBeenCalled();
    await ru.service.leaderboard(DAY, 'u-1', 'en');
    expect(ru.repo.rankOf.mock.calls.at(-1)?.[3]).toBe('');
  });
});
