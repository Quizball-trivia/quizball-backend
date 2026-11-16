import { describe, expect, it } from 'vitest';
import { boardNamesake, buildDirectory, judge, withRussian, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';

// Invented footballers only: the repository is public.
const E = (eid: string, name: string, known: string, fame: number, aliases: string[] = []): TenableEntity =>
  ({ eid, name, known, fame, aliases, qualifier: null });
const ROWS = [
  E('star', 'Alvo Bressan', 'Alvo', 95),
  E('other', 'Alvo Carrel', 'Alvo', 20),
  E('third', 'Alvo Denner', 'Alvo', 15),
  E('w-a', 'Ben Wardle', 'Wardle', 70),
  E('w-b', 'Joe Wardle', 'Wardle', 10),
  E('r-a', 'Tiko Ronda', 'Ronda', 60),
  E('r-b', 'Sami Ronda', 'Ronda', 60),
  E('solo', 'Pim Quaid', 'Quaid', 40),
];
const dir = buildDirectory('player', 'rel', ROWS);

describe('board namesakes: the board chooses only between holders of the very name typed', () => {
  it('a name the release gives to someone off the board means its one holder on the board', () => {
    expect(dir.identify('Alvo')).toEqual({ kind: 'entity', eid: 'star' });
    expect(boardNamesake(dir, 'Alvo', 'star', (eid) => eid === 'other')).toBe('other');
    expect(judge(dir, ['other', 'solo'], new Set(), 'Alvo')).toEqual({ kind: 'right', slot: 0, eid: 'other' });
    expect(judge(dir, ['w-b'], new Set(), 'wardle')).toEqual({ kind: 'right', slot: 0, eid: 'w-b' });
  });

  it('the release reading wins when its holder is on the board', () => {
    expect(judge(dir, ['star', 'other'], new Set(), 'Alvo')).toEqual({ kind: 'right', slot: 0, eid: 'star' });
  });

  it('two holders on the board, or none, leave the release reading (wrong costs as before)', () => {
    expect(judge(dir, ['other', 'third'], new Set(), 'Alvo')).toEqual({ kind: 'wrong', eid: 'star' });
    expect(judge(dir, ['solo'], new Set(), 'Alvo')).toEqual({ kind: 'wrong', eid: 'star' });
  });

  it('a text the release cannot decide stays undecided, whatever the board holds (a vague name is never a free guess)', () => {
    expect(dir.identify('Ronda')).toEqual({ kind: 'ambiguous' });
    expect(judge(dir, ['r-a'], new Set(), 'Ronda')).toEqual({ kind: 'ambiguous' });
    expect(judge(dir, ['solo'], new Set(), 'Nobody Here')).toEqual({ kind: 'unknown' });
  });

  it('a typo never reaches a namesake: only exact names, words and compact forms count', () => {
    expect(dir.namesakes('Alvoo')).toEqual([]);
    expect(dir.namesakes('Alvo').slice().sort()).toEqual(['other', 'star', 'third']);
    expect(judge(dir, ['other'], new Set(), 'Alvoo')).not.toMatchObject({ kind: 'right' });
  });

  it('a picked id is that entity, never re-read by the board', () => {
    expect(judge(dir, ['other'], new Set(), 'Alvo', 'star')).toEqual({ kind: 'wrong', eid: 'star' });
  });

  it('a wrong entity already paid for stays a free repeat, never a rescue (no free probe after a miss)', () => {
    expect(judge(dir, ['other'], new Set(), 'Alvo', null, new Set(['star']))).toEqual({ kind: 'wrong', eid: 'star' });
    expect(judge(dir, ['other'], new Set(), 'Alvo', null, new Set())).toEqual({ kind: 'right', slot: 0, eid: 'other' });
  });

  it('a namesake already found is not rescued: the costly wrong stands (no free probe of the list)', () => {
    expect(judge(dir, ['other'], new Set([0]), 'Alvo')).toEqual({ kind: 'wrong', eid: 'star' });
    expect(judge(dir, ['other', 'third'], new Set([0]), 'Alvo')).toEqual({ kind: 'wrong', eid: 'star' });
  });

  it('a stale pick falls back to the typed text, rescue included', () => {
    expect(judge(dir, ['other'], new Set(), 'Alvo', 'nope')).toEqual({ kind: 'right', slot: 0, eid: 'other' });
  });

  it('every verdict but right is the same for any board (no oracle)', () => {
    const boards: Array<[string[], number[]]> = [[['other'], []], [['other'], [0]], [['solo'], []], [['other', 'third'], []], [['other', 'third'], [0]], [['r-a'], []], [[], []]];
    for (const text of ['Alvo', 'Ronda', 'Alvoo', 'Nobody Here', 'Pim Quaid']) {
      const seen = new Set(boards.map(([b, f]) => judge(dir, b, new Set(f), text)).filter((v) => v.kind !== 'right').map((v) => JSON.stringify(v)));
      expect(seen.size).toBeLessThanOrEqual(1);
    }
  });

  it('Cyrillic text chooses among the Russian names', () => {
    const ru = buildDirectory('player', 'rel', ROWS.map((r) => ({ ...r, name: r.eid === 'other' ? 'Альво Каррель' : r.eid === 'star' ? 'Альво Брессан' : r.name, known: r.eid === 'other' || r.eid === 'star' ? 'Альво' : r.known })), 'cyrillic');
    const both = withRussian(dir, ru);
    expect(judge(both, ['other'], new Set(), 'Альво')).toEqual({ kind: 'right', slot: 0, eid: 'other' });
  });
});

