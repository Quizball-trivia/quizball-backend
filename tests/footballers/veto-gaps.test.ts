import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awaitFootballerNames, currentFootballerNames, FOOTBALLER_NAMES_LOADING, footballerNamesOf, installFootballerNames,
} from '../../src/modules/footballers/footballers.names.js';
import { buildGreekIndex, buildUniverse, type UniversePlayer } from '../../src/modules/footballers/footballers.universe.js';
import { isAcceptedGuess } from '../../src/modules/pistas/pistas.normalize.js';
import { matchAnswer, type UltimoCategory } from '../../src/modules/ultimo/ultimo.match.js';
import { fuzzyMatchesAnswer, matchAnswerV2 } from '../../src/realtime/possession-answer-matching.js';
import { buildDirectory, footballerTypoVeto, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';
import { resolvePassChainPlayer } from '../../src/modules/daily-challenges/pass-chain.resolve.js';
import { resolveSquadSpinAnswer } from '../../src/modules/squad-spin/squad-spin.resolver.js';
import { NAMES, UNIVERSE } from './names-fixture.js';

// Invented footballers only (names-fixture.ts), with invented Greek spellings of two of them.
const P = (pid: string, name: string, fame: number): UniversePlayer => ({ pid, name, game: name.split(' ').pop()!, fame, aliases: [] });
const GREEK = buildGreekIndex('el-1', [P('var-a', 'Τομας Βαρνικ', 70), P('var-b', 'Ταμας Βαρνικ', 10)]);
const WITH_GREEK = footballerNamesOf(UNIVERSE, GREEK);
const TOMAS = ['Tomas Varnik', 'Varnik', 'Τομας Βαρνικ', 'Βαρνικ'];

const same = (name: string) => ({ es: name, en: name, ka: name, tr: name });
const answer = (id: string, name: string) => ({ id, display: same(name), aliases: [] });
const CATEGORY: UltimoCategory = {
  id: 'gaps', difficulty: 'easy', title: same('Lista inventada'), hint: same('Inventada'),
  answers: [answer('var', 'Tomas Varnik'), answer('a', 'Aldo Primo'), answer('b', 'Beto Segundo'), answer('c', 'Ciro Tercero'),
    answer('d', 'Dino Cuarto'), answer('e', 'Enzo Quinto'), answer('f', 'Fabio Sexto'), answer('g', 'Gino Septimo')],
};
const MANAGERS = (rows: Array<[string, string, string]>): TenableEntity[] =>
  rows.map(([eid, name, known]) => ({ eid, name, known, fame: 50, aliases: [], qualifier: null }));

afterEach(() => installFootballerNames(null));

describe('gap 1: Greek answers go through the veto when the release has Greek names', () => {
  it('Pistas and Clue Chain refuse a Greek typo that is another footballer\'s Greek name', () => {
    expect(isAcceptedGuess(TOMAS, 'Ταμας Βαρνικ', WITH_GREEK)).toBe(false);
    expect(fuzzyMatchesAnswer('Ταμας Βαρνικ', TOMAS, WITH_GREEK)).toBe(false);
    expect(matchAnswerV2('Ταμας Βαρνικ', TOMAS, WITH_GREEK)).toBeNull();
    // A plain Greek typo and the Greek name itself still count.
    expect(isAcceptedGuess(TOMAS, 'Τομας Βαρνκ', WITH_GREEK)).toBe(true);
    expect(isAcceptedGuess(TOMAS, 'Τομάς Βάρνικ', WITH_GREEK)).toBe(true);
    expect(fuzzyMatchesAnswer('Τομας Βαρνκ', TOMAS, WITH_GREEK)).toBe(true);
  });

  it('without Greek names (none active) a Greek text judges exactly as before, and Latin is unchanged', () => {
    expect(isAcceptedGuess(TOMAS, 'Ταμας Βαρνικ', NAMES)).toBe(true);
    expect(fuzzyMatchesAnswer('Ταμας Βαρνικ', TOMAS, NAMES)).toBe(true);
    expect(isAcceptedGuess(TOMAS, 'Tamas Varnik', WITH_GREEK)).toBe(false);
    expect(isAcceptedGuess(TOMAS, 'Tomas Varnk', WITH_GREEK)).toBe(true);
  });

  it('a Greek manager directory refuses the typo as the Latin one does', () => {
    const latin = buildDirectory('manager', 'rel', MANAGERS([['m-var', 'Tomas Varnik', 'Varnik']]), 'latin', () => footballerTypoVeto(WITH_GREEK));
    const greek = buildDirectory('manager', 'rel', MANAGERS([['m-var', 'Τομας Βαρνικ', 'Βαρνικ']]), 'greek', () => footballerTypoVeto(WITH_GREEK));
    expect(latin.identify('Tamas Varnik')).toEqual({ kind: 'unknown' });
    expect(greek.identify('Ταμας Βαρνικ')).toEqual({ kind: 'unknown' });
    expect(greek.identify('Τομας Βαρνκ')).toEqual({ kind: 'entity', eid: 'm-var' });
  });

  it('Greek names that could not be loaded yet hold Greek typos back, nothing else, and only until their deadline', () => {
    const loading = footballerNamesOf(UNIVERSE, 'loading');
    expect(isAcceptedGuess(TOMAS, 'Τομας Βαρνκ', loading)).toBe(false);
    expect(isAcceptedGuess(TOMAS, 'Τομας Βαρνικ', loading)).toBe(true);
    expect(isAcceptedGuess(TOMAS, 'Tomas Varnk', loading)).toBe(true);
    expect(isAcceptedGuess(TOMAS, 'Τομας Βαρνκ', footballerNamesOf(UNIVERSE, 'loading', { pendingUntil: Date.now() - 1 }))).toBe(true);
  });
});

describe('gap 2: spaces never hide another footballer\'s name', () => {
  it('Pistas', () => {
    expect(isAcceptedGuess(['Tomas Varnik'], 'TamasVarnik', NAMES)).toBe(false);
    expect(isAcceptedGuess(['Tomas Varnik'], 'Tamas Varn ik', NAMES)).toBe(false);
    expect(isAcceptedGuess(['Tomas Varnik'], 'TomasVarnik', NAMES)).toBe(true);
    expect(isAcceptedGuess(['Tomas Varnik'], 'TomasVarnk', NAMES)).toBe(true);
  });

  it('Clue Chain v1 and v2', () => {
    expect(fuzzyMatchesAnswer('TamasVarnik', ['Tomas Varnik'], NAMES)).toBe(false);
    expect(matchAnswerV2('TamasVarnik', ['Tomas Varnik'], NAMES)).toBeNull();
    expect(matchAnswerV2('TomasVarnk', ['Tomas Varnik'], NAMES)?.kind).toBe('typo');
  });

  it('Último, Tenable managers and Pass Chain', () => {
    expect(matchAnswer(CATEGORY, 'TamasVarnik', NAMES)).toEqual({ kind: 'none' });
    expect(matchAnswer(CATEGORY, 'TomasVarnk', NAMES)).toEqual({ kind: 'answer', index: 0 });
    const managers = buildDirectory('manager', 'rel', MANAGERS([['m-gal', 'Ezio Galtero', 'Galtero']]), 'latin', () => footballerTypoVeto(NAMES));
    expect(managers.identify('EzioGautero')).toEqual({ kind: 'unknown' });
    // Pass Chain players carry the release's ids.
    const pool = [{ id: 'var-a', normalized_aliases: ['tomas varnik', 'varnik'] }];
    expect(resolvePassChainPlayer(pool, 'TamasVarnik', {}, NAMES)).toBeNull();
    expect(resolvePassChainPlayer(pool, 'Tomas Varnk', {}, NAMES)?.id).toBe('var-a');
    // Spaces placed anew that name the answer itself still credit it, also where the game's ids are not the release's.
    expect(resolvePassChainPlayer(pool, 'TomasVarnik', {}, NAMES)?.id).toBe('var-a');
    const own = [{ id: 'pc-var', normalized_aliases: ['tomas varnik', 'varnik'] }];
    expect(resolvePassChainPlayer(own, 'TomasVarnik', {}, NAMES)?.id).toBe('pc-var');
    expect(resolvePassChainPlayer(own, 'TamasVarnik', {}, NAMES)).toBeNull();
    const squad = [{ id: 'sq-var', name_en: 'Tomas Varnik' }];
    expect(resolveSquadSpinAnswer('TomasVarnik', [], squad, NAMES).playerId).toBe('sq-var');
    expect(resolveSquadSpinAnswer('TamasVarnik', [], squad, NAMES).playerId).toBeNull();
    expect(resolveSquadSpinAnswer('Tomas Varnikk', [], squad, NAMES).playerId).toBe('sq-var');
  });
});

describe('gap 3: no typo is forgiven before the names are loaded', () => {
  it('while loading only exact answers count; once installed typos are judged with the veto', () => {
    awaitFootballerNames();
    expect(currentFootballerNames()).toBe(FOOTBALLER_NAMES_LOADING);
    expect(isAcceptedGuess(['Tomas Varnik'], 'Tamas Varnik')).toBe(false);
    expect(isAcceptedGuess(['Tomas Varnik'], 'Tomas Varnk')).toBe(false);
    expect(isAcceptedGuess(['Tomas Varnik'], 'Tomas Varnik')).toBe(true);
    expect(fuzzyMatchesAnswer('Tomas Varnk', ['Tomas Varnik'])).toBe(false);
    expect(fuzzyMatchesAnswer('Varnik', ['Tomas Varnik'])).toBe(true);
    expect(matchAnswer(CATEGORY, 'Tomas Varnk')).toEqual({ kind: 'none' });
    expect(matchAnswer(CATEGORY, 'Tomas Varnik')).toEqual({ kind: 'answer', index: 0 });
    const managers = buildDirectory('manager', 'rel', MANAGERS([['m-gal', 'Ezio Galtero', 'Galtero']]), 'latin', () => footballerTypoVeto(currentFootballerNames()));
    expect(managers.identify('Ezio Galtro')).toEqual({ kind: 'unknown' });

    installFootballerNames(NAMES);
    expect(isAcceptedGuess(['Tomas Varnik'], 'Tamas Varnik')).toBe(false);
    expect(isAcceptedGuess(['Tomas Varnik'], 'Tomas Varnk')).toBe(true);
    expect(managers.identify('Ezio Galtro')).toEqual({ kind: 'entity', eid: 'm-gal' });
  });

  it('a process that never loads the names (no release, tests, tools) judges as before', () => {
    expect(currentFootballerNames()).toBeNull();
    expect(isAcceptedGuess(['Tomas Varnik'], 'Tomas Varnk')).toBe(true);
  });
});

describe('gap 2: re-spacing reads typos only, and reads the answer the same way', () => {
  const names = footballerNamesOf(buildUniverse('rel-space', [
    P('ama-t', 'Teo Amarilon', 50), P('ama-o', 'Ama Rilon', 10),
    { pid: 'var-t', name: 'Tomas Varnik', game: 'Varnik', fame: 70, aliases: ['Tommo Varnik'] }, P('var-o', 'Tamas Varnik', 10),
    P('kel-a', 'Alden Varo De Kelm', 40), P('kel-o', 'Aldon Varo De Kelm', 10),
  ]));

  it('a reading the answer\'s own words decide is never refused by an unrelated split of it', () => {
    expect(matchAnswerV2('Amarilon', ['Teo Amarilon', 'Amarilon'], names)).not.toBeNull();
    expect(matchAnswerV2('Amari lon', ['Teo Amarilon', 'Amarilon'], names)).not.toBeNull();
  });

  it('answer forms are read as written: a one-word club is never split into footballers', () => {
    const club = footballerNamesOf(buildUniverse('rel-club', [P('ama-o', 'Ama Rilon', 10), P('amr-o', 'Amar Lon', 10)]));
    const category: UltimoCategory = { ...CATEGORY, answers: [...CATEGORY.answers.slice(1), answer('club', 'Amarilon')] };
    expect(matchAnswer(category, 'Amarlon', club)).toEqual({ kind: 'answer', index: category.answers.length - 1 });
  });

  it('Pass Chain: words inside a longer name keep their own spacing', () => {
    const pool = [{ id: 'pc-teo', normalized_aliases: ['teo amari lon'] }];
    expect(resolvePassChainPlayer(pool, 'Amari Lon', {}, names)?.id).toBe('pc-teo');
  });

  it('a four-word name typed without spaces', () => {
    expect(isAcceptedGuess(['Alden Varo De Kelm'], 'Aldon Varo De Kelm', names)).toBe(false);
    expect(isAcceptedGuess(['Alden Varo De Kelm'], 'AldonVaroDeKelm', names)).toBe(false);
    expect(isAcceptedGuess(['Alden Varo De Kelm'], 'AldenVaroDeKelmm', names)).toBe(true);
  });
});

describe('CodeRabbit on #1010', () => {
  it('a text that, with its spaces placed anew, names a valid answer is that answer, not a typo of another one', () => {
    // var-b is valid under a local name the release does not use; var-a is one typo away.
    const squad = [{ id: 'var-a', name_en: 'Tomas Varnik' }, { id: 'var-b', name_en: 'Tammy Varnik' }];
    expect(resolveSquadSpinAnswer('TamasVarnik', [], squad, NAMES).playerId).toBe('var-b');
    const pool = [{ id: 'var-a', normalized_aliases: ['tomas varnik'] }, { id: 'var-b', normalized_aliases: ['tammy varnik'] }];
    expect(resolvePassChainPlayer(pool, 'TamasVarnik', {}, NAMES)?.id).toBe('var-b');
  });

  it('a Greek manager typo held back while Greek names load is read again once their deadline passes', () => {
    vi.useFakeTimers();
    try {
      const loading = footballerNamesOf(UNIVERSE, 'loading', { pendingUntil: Date.now() + 1_000 });
      const greek = buildDirectory('manager', 'rel', MANAGERS([['m-var', 'Τομας Βαρνικ', 'Βαρνικ']]), 'greek', () => footballerTypoVeto(loading));
      expect(greek.identify('Τομας Βαρνκ')).toEqual({ kind: 'unknown' });
      vi.advanceTimersByTime(1_000);
      expect(greek.identify('Τομας Βαρνκ')).toEqual({ kind: 'entity', eid: 'm-var' });
    } finally {
      vi.useRealTimers();
    }
  });
});
