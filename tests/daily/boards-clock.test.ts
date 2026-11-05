import { describe, expect, it } from 'vitest';
import '../setup.js';
import { createDailyCalendar } from '../../src/modules/daily/daily.calendar.js';
import { createDailyService } from '../../src/modules/daily/daily.service.js';

const calendar = createDailyCalendar({ contentStart: '2026-10-01', rankedStart: '2026-10-01', publishedDays: 60 });

describe('boards()', () => {
  it('filters by the clock after the content has loaded, so a load running past midnight still lists the new day', async () => {
    // 23:59:59.990 in Buenos Aires (UTC-3) when the request starts; the load finishes after midnight.
    let clock = new Date('2026-11-06T02:59:59.990Z');
    const content = async () => {
      clock = new Date('2026-11-06T03:00:05Z');
      return new Map([['2026-11-06', { day: '2026-11-06', contentVersion: 2 }]]);
    };
    const core = createDailyService(
      { repo: {} as never, content, contentStale: () => undefined, now: () => clock },
      {
        newState: () => ({}),
        project: (s) => s,
        rebase: (s) => s,
        completion: () => null,
        publicState: () => ({ day: '2026-11-06', done: false, ranked: false }),
      },
      { calendar, rankedFrom: '2026-10-01', leaderboardTop: 10, leaderboardCacheMs: 1000 },
    );
    await expect(core.boards()).resolves.toEqual({ days: { '2026-11-06': 2 }, rankedFrom: '2026-10-01' });
  });
});
