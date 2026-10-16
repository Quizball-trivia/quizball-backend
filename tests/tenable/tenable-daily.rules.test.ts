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
