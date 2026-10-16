import { describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { createDailyService, LoadFirst } from '../../src/modules/daily/daily.service.js';
import { nameChainCalendar } from '../../src/modules/name-chain-daily/name-chain-daily.days.js';

type State = { n: number };
const DAY = '2026-10-01';
const day = { day: DAY, contentVersion: 1 };
const row = {
  id: 'run', user_id: 'u', guest_id: null, day: DAY, ranked: false, content_version: 1, state: { n: 0 }, state_version: 1,
  done: false, score: null, completed_at: null, closes_at: new Date(0), closed: true,
};

/** A service whose run's day needs something loaded first, `cold` times in a row. */
function service(cold: number) {
  let open = false;
  const loadedWhileOpen: boolean[] = [];
  const load = vi.fn(async () => { loadedWhileOpen.push(open); });
  let misses = cold;
  const repo = {
    withTx: vi.fn(async (fn: (tx: never) => Promise<unknown>) => {
      open = true;
      try { return await fn({} as never); } finally { open = false; }
    }),
    lockDay: vi.fn(async () => 1),
    dayVersion: vi.fn(async () => 1),
    runDay: vi.fn(async () => DAY),
    lockRun: vi.fn(async () => row),
    saveState: vi.fn(async (_tx: unknown, _id: string, data: { state: State; stateVersion: number }) => ({ ...row, state: data.state, state_version: data.stateVersion })),
    rankOf: vi.fn(async () => null),
  };
  const core = createDailyService(
    { repo: repo as never, content: async () => new Map([[DAY, day]]), contentStale: () => undefined, now: () => new Date('2026-10-15T12:00:00Z') },
    {
      newState: () => ({ n: 0 }),
      dayFor: async (d) => {
        if (misses > 0) { misses -= 1; throw new LoadFirst(load); }
        return d;
      },
      project: (s) => s,
      rebase: (s) => s,
      completion: () => null,
      publicState: (s: State) => ({ day: DAY, done: false, ranked: false, n: s.n }),
    },
    { calendar: nameChainCalendar, rankedFrom: '2026-01-01', leaderboardTop: 10, leaderboardCacheMs: 1000 },
  );
  const move = () => core.mutate({ kind: 'member', userId: 'u' } as never, 'run', 1, (s) => ({ state: { n: s.n + 1 } }));
  return { move, load, repo, loadedWhileOpen };
}

describe('a run whose frozen content is not in memory', () => {
  it('is loaded outside the transaction, then the move runs again and is saved once', async () => {
    const { move, load, repo } = service(1);
    const out = await move();
    expect(load).toHaveBeenCalledTimes(1);
    expect(repo.withTx).toHaveBeenCalledTimes(2);
    expect(repo.saveState).toHaveBeenCalledTimes(1);
    expect(out.state).toMatchObject({ n: 1 });
  });

  it('missing again after the load: a stale-state answer, so the client re-syncs', async () => {
    const { move, repo } = service(2);
    await expect(move()).rejects.toMatchObject({ statusCode: 409, message: 'stale_state' });
    expect(repo.saveState).not.toHaveBeenCalled();
  });

  it('never loads while a transaction is open', async () => {
    const { move, loadedWhileOpen } = service(1);
    await move();
    expect(loadedWhileOpen).toEqual([false]);
  });
});
