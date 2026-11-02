import { describe, expect, it } from 'vitest';
import { buildDirectory, TENABLE_MATCHER_VERSION, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';
import { listProblems, type TenableList } from '../../src/modules/tenable/tenable.content.js';
import * as rules from '../../src/modules/tenable-daily/tenable-daily.rules.js';

// Invented footballers only: the repository is public.
const names = ['Bako', 'Orlen', 'Ronda', 'Valen', 'Brando', 'Tobin', 'Perel', 'Ilter', 'Marco', 'Sendo', 'Outsider'];
const rows: TenableEntity[] = names.map((n, i) => ({ eid: `p${i}`, name: `Tarin ${n}`, known: n, fame: 80, aliases: [], qualifier: null }));
const directory = buildDirectory('player', 'rel', rows);
const list: TenableList = {
  id: 'l', kind: 'player', release: 'rel', matcher: TENABLE_MATCHER_VERSION, tier: 'easy', topicKey: 't',
  title: { en: 'x', es: 'x', ka: 'x', tr: 'x' }, note: null, asOf: null,
  slots: rows.slice(0, 10).map((r, i) => ({ eid: r.eid, figure: { value: 10 - i, unit: 'goals' } })),
} as TenableList;

describe('tenable daily rules', () => {
  it('a finished run refuses every further move (it is never saved again)', () => {
    const over = rules.giveUp(rules.newState());
    expect(() => rules.say(over, list, directory, 'Tarin Bako', null)).toThrow('run_done');
    expect(() => rules.giveUp(over)).toThrow('run_done');
  });

  it('a repeated wrong answer costs one life only', () => {
    const once = rules.say(rules.newState(), list, directory, 'Tarin Outsider', null);
    const twice = rules.say(once, list, directory, 'Tarin Outsider', null);
    expect(once.l).toBe(rules.LIVES - 1);
    expect(twice.l).toBe(rules.LIVES - 1);
    expect(twice.last?.kind).toBe('repeatWrong');
  });

  it('hides unfound slots while the run is on, and shows the whole list as soon as it is over (today included)', () => {
    const show = (s: rules.RunState, disclose: boolean) => rules.publicState(s, '2026-10-24', { list, directory }, 0, { ranked: true, disclose });
    let s = rules.say(rules.newState(), list, directory, 'Tarin Ronda', null);
    s = rules.say(s, list, directory, 'Tarin Outsider', null);
    // In progress: only the found slot has a name, even when the day is closed; no other answer is in the payload.
    for (const disclose of [false, true]) {
      const live = show(s, disclose);
      expect(live.disclosed).toBe(false);
      expect(live.slots.filter((x) => x.name !== null).map((x) => x.rank)).toEqual([3]);
      const json = JSON.stringify(live);
      for (const n of names.slice(0, 10).filter((n) => n !== 'Ronda')) expect(json).not.toContain(n);
    }
    // Given up, or out of lives (two more real players who are not on the list), on a day that is still open.
    const extras = buildDirectory('player', 'rel', [...rows, ...['Ghost', 'Phantom'].map((n, i) => ({ eid: `x${i}`, name: `Tarin ${n}`, known: n, fame: 80, aliases: [], qualifier: null }))]);
    const outOfLives = ['Tarin Ghost', 'Tarin Phantom'].reduce((run, text) => rules.say(run, list, extras, text, null), s);
    expect(outOfLives).toMatchObject({ done: true, end: 'lives' });
    for (const over of [rules.giveUp(s), outOfLives]) {
      const end = show(over, false);
      expect(end.disclosed).toBe(true);
      expect(end.slots.map((x) => x.name)).toEqual(names.slice(0, 10).map((n) => `Tarin ${n}`));
      expect(end.slots.every((x) => x.figure !== null)).toBe(true);
      expect(end.slots.map((x) => x.found)).toEqual(names.slice(0, 10).map((n) => n === 'Ronda'));
    }
  });
});

describe('tenable practice towers', () => {
  const day = (d: string, tier: 'easy' | 'medium' | 'hard', asOf: string | null = null) => ({ day: d, list: { tier, asOf } });
  it('offers closed days only, easiest first, then the most recent list, then the newest day; never a hard list', () => {
    const days = [
      day('2026-10-12', 'medium'), day('2026-10-13', 'easy'), day('2026-10-14', 'hard'), day('2026-10-15', 'easy', '2026-08-01'),
      day('2026-10-16', 'easy'), day('2026-10-17', 'medium', '2026-09-01'), day('2026-10-24', 'easy', '2026-10-01'),
    ];
    expect(rules.practiceDays(days, '2026-10-24')).toEqual(['2026-10-15', '2026-10-16', '2026-10-13', '2026-10-17', '2026-10-12']);
    expect(rules.practiceDays(days, '2026-10-25')[0]).toBe('2026-10-24');
    expect(rules.practiceDays(days, '2026-10-24', 2)).toEqual(['2026-10-15', '2026-10-16']);
    expect(rules.practiceDays([day('2026-10-12', 'hard')], '2026-10-24')).toEqual([]);
  });
});

describe('listProblems: namesakes', () => {
  const twins = (qa: string | null, qb: string | null) => buildDirectory('player', 'rel', [
    ...rows.slice(0, 10),
    { eid: 'twin-a', name: 'Juan Perel', known: 'Perel', fame: 30, aliases: [], qualifier: qa },
    { eid: 'twin-b', name: 'Juan Perel', known: 'Perel', fame: 25, aliases: [], qualifier: qb },
  ]);
  const withTwin = { ...list, slots: [...list.slots.slice(0, 9), { eid: 'twin-a', figure: { value: 1, unit: 'goals' } }] } as TenableList;
  it('a slot whose namesake looks the same in the suggestions is a problem', () => {
    expect(listProblems(withTwin, twins(null, null)).some((p) => p.includes('namesake'))).toBe(true);
    expect(listProblems(withTwin, twins('Club A · 1990', 'Club A · 1990')).some((p) => p.includes('namesake'))).toBe(true);
  });
  it('qualifiers that tell them apart are fine', () => {
    expect(listProblems(withTwin, twins('Club A · 1990', 'Club B · 1994'))).toEqual([]);
  });
});
