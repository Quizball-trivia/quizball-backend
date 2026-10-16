import { describe, expect, it } from 'vitest';
import { createDailyCalendar } from '../../src/modules/daily/daily.calendar.js';
import type { DailyRunRowBase } from '../../src/modules/daily/daily.repo.js';
import { createDailyService, type DailyServiceRepo } from '../../src/modules/daily/daily.service.js';
import type { TransactionSql } from '../../src/db/index.js';

// A toy daily game: one move finishes the run; a "timed" run finishes on its own once its deadline passes.
interface State { moves: number; until: number | null; expired?: boolean }
type Row = DailyRunRowBase<State>;
const DAY = '2026-10-20';
const NOW = new Date('2026-10-20T15:00:00Z');
const tx = {} as TransactionSql;
const finished = (s: State) => s.moves > 0 || s.expired === true;

function setup(initial: State = { moves: 0, until: null }) {
  let row: Row | null = null;
  let boardLoads = 0;
  let clock = NOW.getTime();
  const save = (state: State, version: number): Row => {
    const done = finished(state);
    row = { ...row!, state, state_version: version, done, score: done ? 1 : null, completed_at: done ? new Date(clock) : null };
    return row;
  };
  const repo: DailyServiceRepo<State, Row, never> = {
    withTx: (fn) => fn(tx),
    lockDay: async () => 1,
    dayVersion: async () => 1,
    async insertRun(_tx, d) {
      if (row) return null;
      row = { id: d.id, user_id: 'user-a', guest_id: null, day: d.day, ranked: d.ranked, content_version: 1, state: initial, state_version: 1,
        done: false, score: null, completed_at: null, closes_at: d.closesAt, closed: false };
      return row;
    },
    lockOwnRun: async () => row,
    runDay: async () => row?.day ?? null,
    lockRun: async () => row,
    getRun: async () => row,
    saveState: async (_tx, _id, d) => save(d.state, d.stateVersion),
    unrankClosedRun: async () => null,
    rebaseRun: async () => null,
    isClosed: async () => false,
    rankOf: async () => null,
    async leaderboard() { boardLoads += 1; return { players: 0, top: [] }; },
  };
  const svc = createDailyService<State, Row, never, { day: string; contentVersion: number }, { day: string; done: boolean; ranked: boolean }>(
    { repo, content: async () => new Map([[DAY, { day: DAY, contentVersion: 1 }]]), contentStale: () => {}, now: () => new Date(clock) },
    {
      newState: () => initial,
      project: (s, now) => (s.until !== null && now >= s.until && !s.expired ? { ...s, expired: true } : s),
      rebase: (s) => s,
      completion: (s) => (finished(s) ? { score: 1, stat: 1 } : null),
      publicState: (s, run) => ({ day: run.day, done: finished(s), ranked: row?.ranked ?? false }),
    },
    { calendar: createDailyCalendar({ contentStart: '2026-10-01', rankedStart: '2026-10-01', publishedDays: 60 }), rankedFrom: '2026-10-01', leaderboardTop: 20, leaderboardCacheMs: 15_000 },
  );
  return { svc, boardLoads: () => boardLoads, advance: (ms: number) => { clock += ms; } };
}

const member = { kind: 'member' as const, userId: 'user-a' };

describe('daily kit board cache', () => {
  it('a finishing move refreshes the board; reopening the finished run does not', async () => {
    const { svc, boardLoads } = setup();
    const { run } = await svc.start(DAY, member);
    await svc.leaderboard(DAY, null);
    await svc.mutate(member, run.id, run.version, (s) => ({ state: { ...s, moves: 1 } }));
    await svc.leaderboard(DAY, null);
    expect(boardLoads()).toBe(2);
    for (let i = 0; i < 3; i += 1) {
      expect((await svc.start(DAY, member)).state.done).toBe(true);
      await svc.leaderboard(DAY, null);
    }
    expect(boardLoads()).toBe(2);
  });

  it('a run whose clock finished it is written down by /start, and that refreshes the board', async () => {
    const { svc, boardLoads, advance } = setup({ moves: 0, until: NOW.getTime() + 1000 });
    await svc.start(DAY, member);
    await svc.leaderboard(DAY, null);
    advance(2000);
    expect((await svc.start(DAY, member)).state.done).toBe(true);
    await svc.leaderboard(DAY, null);
    expect(boardLoads()).toBe(2);
  });
});
