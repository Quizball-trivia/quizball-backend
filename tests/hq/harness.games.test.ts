import { describe, expect, it } from 'vitest';
import '../setup.js';

const { GAMES, gameStats, lastDays, splitWeeks } = await import('../../src/modules/harness/harness.games.js');

describe('games hub', () => {
  it('lists each game once, with a plain runs table name and a state', () => {
    expect(new Set(GAMES.map((g) => g.key)).size).toBe(GAMES.length);
    for (const g of GAMES) {
      for (const t of g.runs ?? []) expect(t).toMatch(/^[a-z0-9_]+_runs(_[a-z]+)?$/);
      expect(['on', 'off', 'paused', 'beta', 'retired']).toContain(g.state());
      expect(g.what.length).toBeGreaterThan(20);
    }
    expect(GAMES.find((g) => g.key === 'ultimo')!.state()).toBe('retired');
    expect(GAMES.find((g) => g.key === 'draft')!.runs).toHaveLength(3);
  });

  it('gives the last 14 days in Georgian time, oldest first', () => {
    const days = lastDays(new Date('2026-11-26T21:30:00Z'));
    expect(days).toHaveLength(14);
    expect(days[13]).toBe('2026-11-27');
    expect(days[0]).toBe('2026-11-14');
  });

  it('splits play counts into the last 7 days and the 7 before', () => {
    const days = lastDays(new Date('2026-11-26T10:00:00Z'));
    const m = splitWeeks([
      { day: '2026-11-26', mode: 'ranked', games: 10 },
      { day: '2026-11-20', mode: 'ranked', games: 5 },
      { day: '2026-11-19', mode: 'ranked', games: 7 },
      { day: '2026-11-13', mode: 'ranked', games: 2 },
      { day: '2026-11-01', mode: 'ranked', games: 99 },
    ], days);
    expect(m.get('ranked')).toEqual({ now: 15, before: 9 });
  });

  it('adds up a game across its runs tables and its room version; a mode with no plays is zero, a game nothing counts is null', () => {
    const runs = new Map([
      ['draft_runs_budget', { tbl: 'draft_runs_budget', started_now: '100', started_before: '80', done_now: '60', done_before: '50' }],
      ['draft_runs_classic', { tbl: 'draft_runs_classic', started_now: '10', started_before: '5', done_now: '4', done_before: '1' }],
    ]);
    const modes = new Map([['room_draft', { now: 12, before: 3 }]]);
    const draft = GAMES.find((g) => g.key === 'draft')!;
    expect(gameStats(draft, runs, modes)).toEqual({ started: { now: 110, before: 85 }, finished: { now: 64, before: 51 }, played: { now: 12, before: 3 } });
    expect(gameStats({ modes: ['auction'] }, runs, modes)).toEqual({ started: null, finished: null, played: { now: 0, before: 0 } });
    expect(gameStats({}, runs, modes)).toEqual({ started: null, finished: null, played: null });
  });
});
