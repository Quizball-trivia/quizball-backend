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

  it('a shared name the release cannot decide: its open holder on the list is right, none is a costly wrong', () => {
    expect(dir.identify('Ronda')).toEqual({ kind: 'ambiguous' });
    expect(judge(dir, ['r-b'], new Set(), 'Ronda')).toEqual({ kind: 'right', slot: 0, eid: 'r-b' });
    expect(judge(dir, ['r-a', 'r-b'], new Set(), 'Ronda')).toEqual({ kind: 'right', slot: 0, eid: 'r-a' });
    expect(judge(dir, ['r-a', 'r-b'], new Set([0]), 'Ronda')).toEqual({ kind: 'right', slot: 1, eid: 'r-b' });
    expect(judge(dir, ['r-a'], new Set([0]), 'Ronda')).toMatchObject({ kind: 'wrong' });
    expect(judge(dir, ['solo'], new Set(), 'Ronda')).toMatchObject({ kind: 'wrong' });
    expect(judge(dir, ['solo'], new Set(), 'Nobody Here')).toEqual({ kind: 'unknown' });
  });

  it('a shared name whose best-known holder is already paid for is that same wrong again, whatever the list holds', () => {
    expect(judge(dir, ['r-b'], new Set(), 'Ronda', null, new Set(['r-a']))).toEqual({ kind: 'wrong', eid: 'r-a' });
    expect(judge(dir, ['solo'], new Set(), 'Ronda', null, new Set(['r-a']))).toEqual({ kind: 'wrong', eid: 'r-a' });
  });

  it('a short typo close to several people stays ambiguous and free, whatever the list holds', () => {
    expect(dir.identify('Rondaa')).toEqual({ kind: 'ambiguous' });
    expect(dir.nearby('Rondaa')).toEqual([]);
    expect(judge(dir, ['r-a'], new Set(), 'Rondaa')).toEqual({ kind: 'ambiguous' });
    expect(judge(dir, ['solo'], new Set(), 'Rondaa')).toEqual({ kind: 'ambiguous' });
  });

  it('a long typo close to several people is right only when exactly one of them is open on the list', () => {
    const long = buildDirectory('player', 'rel', [
      E('k-a', 'Kelvaro Montesinos', 'Montesinos', 60), E('k-b', 'Kelvaro Montesinas', 'Montesinas', 50), E('solo', 'Pim Quaid', 'Quaid', 40),
    ]);
    const typo = 'Kelvaro Montesinus';
    expect(long.identify(typo)).toEqual({ kind: 'ambiguous' });
    expect(long.nearby(typo)).toEqual(['k-a', 'k-b']);
    expect(judge(long, ['k-b', 'solo'], new Set(), typo)).toEqual({ kind: 'right', slot: 0, eid: 'k-b' });
    // Both on the list: still a guess between two people, so a costly wrong (never a free probe).
    expect(judge(long, ['k-a', 'k-b'], new Set(), typo)).toEqual({ kind: 'wrong', eid: 'k-a' });
    expect(judge(long, ['k-b'], new Set([0]), typo)).toEqual({ kind: 'wrong', eid: 'k-a' });
    expect(judge(long, ['solo'], new Set(), typo)).toEqual({ kind: 'wrong', eid: 'k-a' });    // An unfinished word is not a typo: never read against the list.
    expect(long.nearby('Kelvaro Montesin M')).toEqual([]);
  });

  it('a name in another script is read against the list only when its holders share a Latin name', () => {
    const ka = buildDirectory('player', 'rel', [
      E('h-a', 'Remo Herrano', 'Herrano', 40, ['ჰერანო']), E('h-b', 'Tavo Herrana', 'Herrana', 40, ['ჰერანო']),
      E('v-a', 'Ugo Vellin', 'Vellin', 40, ['ველინი']), E('v-b', 'Ari Vellin', 'Vellin', 40, ['ველინი']), E('solo', 'Pim Quaid', 'Quaid', 20),
      E('d-a', 'Sava Dornek', 'Sava Dornek', 40, ['დორნეკი']), E('d-b', 'Dornek', 'Dornek', 35, ['დორნეკი']),
    ]);
    // One Georgian spelling for two different Latin names: never a board reading, free whatever the list holds.
    expect(judge(ka, ['h-b'], new Set(), 'ჰერანო')).toEqual({ kind: 'ambiguous' });
    expect(judge(ka, ['solo'], new Set(), 'ჰერანო')).toEqual({ kind: 'ambiguous' });
    // Two players with the same Latin surname: read against the list as in Latin.
    expect(judge(ka, ['v-b'], new Set(), 'ველინი')).toEqual({ kind: 'right', slot: 0, eid: 'v-b' });
    expect(judge(ka, ['v-b'], new Set(), 'Vellin')).toEqual({ kind: 'right', slot: 0, eid: 'v-b' });
    // A full known name and a surname-only known name are the same Latin name.
    expect(judge(ka, ['d-b'], new Set(), 'დორნეკი')).toEqual({ kind: 'right', slot: 0, eid: 'd-b' });
    // A shared first name is not a shared name: "Remo Herrano" and "Remo Herrana" stay apart.
    const first = buildDirectory('player', 'rel', [
      E('f-a', 'Remo Herrano', 'Herrano', 40, ['ჰერანო', 'Remo 12']), E('f-b', 'Remo Herrana', 'Herrana', 40, ['ჰერანო', 'Remo 12']),
    ]);
    expect(judge(first, ['f-b'], new Set(), 'ჰერანო')).toEqual({ kind: 'ambiguous' });
    expect(boardNamesake(first, 'ჰერანო', 'f-a', (eid) => eid === 'f-b')).toBeNull();
    // Nor is a shared alias tag, nickname or suffix: only each holder's own name and known name count.
    const tagged = buildDirectory('player', 'rel', [
      E('t-a', 'Remo Herrano', 'Herrano', 40, ['ჰერანო', 'Remo Herrano (FC Vellmora)', 'Red Fox', 'Jr']),
      E('t-b', 'Tavo Herrana', 'Herrana', 40, ['ჰერანო', 'Tavo Herrana (FC Vellmora)', 'Red Fox', 'Jr']),
    ]);
    expect(judge(tagged, ['t-b'], new Set(), 'ჰერანო')).toEqual({ kind: 'ambiguous' });
  });

  it('a Georgian name the release reads as someone off the list means its one other holder on the list', () => {
    const ka = buildDirectory('player', 'rel', [
      E('m-a', 'Teo Marrel', 'Marrel', 90, ['ტეო მარელი', 'მარელი']), E('m-b', 'Lev Marrel', 'Marrel', 20, ['ლევ მარელი', 'მარელი']),
      E('m-c', 'Ivo Marrel', 'Marrel', 10, ['ივო მარელი', 'მარელი']), E('solo', 'Pim Quaid', 'Quaid', 20, ['კვეიდი']),
    ]);
    expect(ka.identify('მარელი')).toEqual({ kind: 'entity', eid: 'm-a' });
    expect(boardNamesake(ka, 'მარელი', 'm-a', (eid) => eid === 'm-b')).toBe('m-b');
    // Two other holders on the list: the release's reading stands.
    expect(boardNamesake(ka, 'მარელი', 'm-a', (eid) => eid === 'm-b' || eid === 'm-c')).toBeNull();
    // A player who does not hold the name is never chosen.
    expect(boardNamesake(ka, 'მარელი', 'm-a', (eid) => eid === 'solo')).toBeNull();
  });

  it('a short Georgian surname typo is never read against the list', () => {
    const ka = buildDirectory('player', 'rel', [
      E('t-a', 'Tavo Kuvran', 'Kuvran', 40, ['კუვრანი']), E('t-b', 'Remo Kevran', 'Kevran', 30, ['კევრანი']), E('solo', 'Pim Quaid', 'Quaid', 20),
    ]);
    // One letter from both Georgian surnames: a guess, free whatever the list holds.
    expect(ka.identify('კავრანი')).toEqual({ kind: 'ambiguous' });
    expect(ka.nearby('კავრანი')).toEqual([]);
    expect(judge(ka, ['t-a'], new Set(), 'კავრანი')).toEqual({ kind: 'ambiguous' });
    expect(judge(ka, ['solo'], new Set(), 'კავრანი')).toEqual({ kind: 'ambiguous' });
  });

  it('a typo near one person only never consults the list', () => {
    expect(dir.nearby('Bressann')).toEqual([]);
    expect(judge(dir, ['other'], new Set(), 'Alvo Bressann')).toEqual({ kind: 'wrong', eid: 'star' });
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

