import { describe, it, expect } from 'vitest';
import {
  wlCanTransition,
  wlDueTransition,
  wlNextDueAtMs,
  WL_TERMINAL_STATUSES,
  type WlScheduleView,
} from '../../src/modules/weekend-league/wl-phase.js';
import type { WlTournamentStatus } from '../../src/modules/weekend-league/weekend-league.schemas.js';

const ALL: WlTournamentStatus[] = [
  'scheduled', 'content_pending', 'ready', 'entry_open', 'entry_closed',
  'checkin', 'game_live', 'break', 'qualifier_done', 'final_checkin',
  'final_live', 'completed', 'cancelled', 'voided', 'paused',
];

describe('wlCanTransition', () => {
  it('follows the happy path in order', () => {
    const path: WlTournamentStatus[] = [
      'scheduled', 'content_pending', 'ready', 'entry_open', 'entry_closed',
      'checkin', 'game_live', 'qualifier_done', 'final_checkin', 'final_live', 'completed',
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(wlCanTransition(path[i]!, path[i + 1]!), `${path[i]}→${path[i + 1]}`).toBe(true);
    }
  });

  it('allows the game/break oscillation and the walkover completion', () => {
    expect(wlCanTransition('game_live', 'break')).toBe(true);
    expect(wlCanTransition('break', 'game_live')).toBe(true);
    expect(wlCanTransition('final_checkin', 'completed')).toBe(true);
    expect(wlCanTransition('checkin', 'cancelled')).toBe(true);
  });

  it('terminal states never transition anywhere', () => {
    for (const from of WL_TERMINAL_STATUSES) {
      for (const to of ALL) {
        expect(wlCanTransition(from, to), `${from}→${to}`).toBe(false);
      }
    }
  });

  it('cancel/void/pause are reachable from any non-terminal state', () => {
    for (const from of ALL) {
      if (WL_TERMINAL_STATUSES.includes(from)) continue;
      expect(wlCanTransition(from, 'cancelled'), `${from}→cancelled`).toBe(true);
      expect(wlCanTransition(from, 'voided'), `${from}→voided`).toBe(true);
      if (from !== 'paused') expect(wlCanTransition(from, 'paused'), `${from}→paused`).toBe(true);
    }
  });

  it('paused resumes only via the dedicated path, never plain transitions', () => {
    for (const to of ALL) {
      if (to === 'cancelled' || to === 'voided') continue;
      expect(wlCanTransition('paused', to), `paused→${to}`).toBe(false);
    }
  });

  it('never allows skipping forward or moving backward on the flow', () => {
    expect(wlCanTransition('entry_open', 'checkin')).toBe(false);
    expect(wlCanTransition('checkin', 'entry_open')).toBe(false);
    expect(wlCanTransition('game_live', 'final_live')).toBe(false);
    expect(wlCanTransition('completed', 'final_live')).toBe(false);
  });
});

describe('wlDueTransition / wlNextDueAtMs', () => {
  const base: WlScheduleView = {
    status: 'ready',
    entryOpensAtMs: 1_000,
    entryClosesAtMs: 2_000,
    qualifierStartsAtMs: 10_000,
    finalStartsAtMs: 20_000,
    checkinWindowMs: 600,
  };

  it('fires each boundary exactly at its time', () => {
    expect(wlDueTransition({ ...base, status: 'ready' }, 999)).toBeNull();
    expect(wlDueTransition({ ...base, status: 'ready' }, 1_000)).toBe('entry_open');
    expect(wlDueTransition({ ...base, status: 'entry_open' }, 1_999)).toBeNull();
    expect(wlDueTransition({ ...base, status: 'entry_open' }, 2_000)).toBe('entry_closed');
    expect(wlDueTransition({ ...base, status: 'entry_closed' }, 9_399)).toBeNull();
    expect(wlDueTransition({ ...base, status: 'entry_closed' }, 9_400)).toBe('checkin');
    expect(wlDueTransition({ ...base, status: 'qualifier_done' }, 19_400)).toBe('final_checkin');
  });

  it('live/game phases are never time-driven', () => {
    for (const status of ['checkin', 'game_live', 'break', 'final_checkin', 'final_live'] as const) {
      expect(wlDueTransition({ ...base, status }, 999_999)).toBeNull();
    }
  });

  it('next-due points at the upcoming boundary only when it is ahead', () => {
    expect(wlNextDueAtMs({ ...base, status: 'ready' }, 0)).toBe(1_000);
    expect(wlNextDueAtMs({ ...base, status: 'entry_open' }, 1_500)).toBe(2_000);
    expect(wlNextDueAtMs({ ...base, status: 'entry_open' }, 2_500)).toBeNull();
    expect(wlNextDueAtMs({ ...base, status: 'checkin' }, 9_500)).toBe(10_000);
    expect(wlNextDueAtMs({ ...base, status: 'completed' }, 0)).toBeNull();
  });
});
