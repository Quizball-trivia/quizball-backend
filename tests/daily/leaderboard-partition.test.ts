import { describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { createDailyService } from '../../src/modules/daily/daily.service.js';
import { nameChainCalendar } from '../../src/modules/name-chain-daily/name-chain-daily.days.js';

const DAY = '2026-10-01';

function service(partitioned: boolean) {
  const repo = { leaderboard: vi.fn(async () => ({ players: 0, top: [] })), rankOf: vi.fn(async () => null) };
  const core = createDailyService(
    { repo: repo as never, content: async () => new Map([[DAY, { day: DAY, contentVersion: 1 }]]), contentStale: () => undefined, now: () => new Date('2026-10-15T12:00:00Z') },
    {
      newState: () => ({}), project: (s) => s, rebase: (s) => s, completion: () => null,
      publicState: () => ({ day: DAY, done: false, ranked: false }),
      ...(partitioned ? { boardPartition: (s: { al?: string }) => s.al ?? '' } : {}),
    },
    { calendar: nameChainCalendar, rankedFrom: '2026-01-01', leaderboardTop: 10, leaderboardCacheMs: 1000 },
  );
  return { core, repo };
}

describe('a partitioned daily board', () => {
  it("ranks the player only among the board's own runs", async () => {
    const { core, repo } = service(true);
    await core.leaderboard(DAY, 'u', 'cy');
    await core.leaderboard(DAY, 'u');
    expect(repo.rankOf.mock.calls.map((c) => (c as unknown[])[3])).toEqual(['cy', '']);
  });

  it('a game without partitions ranks as before', async () => {
    const { core, repo } = service(false);
    await core.leaderboard(DAY, 'u');
    expect((repo.rankOf.mock.calls[0] as unknown[])[3]).toBeUndefined();
  });
});
