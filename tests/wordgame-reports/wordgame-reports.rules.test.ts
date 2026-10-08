import { describe, expect, it } from 'vitest';
import { buildUniverse } from '../../src/modules/footballers/footballers.universe.js';
import { refusedForPair, refusedName } from '../../src/modules/wordgame-reports/wordgame-reports.rules.js';

// Invented footballers only: the repository is public.
const universe = buildUniverse('test-release', [
  { pid: 'p1', name: 'Tarin Orlen', game: 'Orlen', fame: 90, aliases: [] },
  { pid: 'p2', name: 'Emir Kosel', game: 'Kosel', fame: 80, aliases: ['Koselinho'] },
  { pid: 'p3', name: 'Dago Ravin', game: 'Ravin', fame: 70, aliases: [] },
]);
const pair = { a: { key: 'club-zeta' }, b: { key: 'club-alfa' }, accepted: ['p1', 'p2'] };

describe('what a "that was right" report is about', () => {
  it('has nothing to report for a text the pair accepts', () => {
    expect(refusedForPair(universe, pair, 'Tarin Orlen')).toBeNull();
    expect(refusedForPair(universe, pair, 'koselinho')).toBeNull();
  });

  it('names the pair by its sorted club keys and the footballer the text means, when it means one', () => {
    expect(refusedForPair(universe, pair, 'Dago Ravin')).toEqual({ release: 'test-release', subject: 'club-alfa|club-zeta', resolvedPid: 'p3' });
  });

  it('keeps a name the release does not know as a claim about the name', () => {
    expect(refusedForPair(universe, pair, 'Milo Vantar')).toEqual({ release: 'test-release', subject: 'club-alfa|club-zeta', resolvedPid: null });
    expect(refusedName(universe, 'Milo Vantar')).toEqual({ release: 'test-release', subject: null, resolvedPid: null });
  });

  it('drops a chain report for a name the release knows (the refusal was about the letter or a repeat)', () => {
    expect(refusedName(universe, 'Emir Kosel')).toBeNull();
  });

  it('drops a text with nothing to read', () => {
    expect(refusedForPair(universe, pair, ' -- ')).toBeNull();
    expect(refusedName(universe, '!!')).toBeNull();
  });
});
