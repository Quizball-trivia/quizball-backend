import { describe, expect, it } from 'vitest';
import {
  boundedTypoDistance,
  footballGridMatchKey,
  footballGridNameIndex,
  footballGridNameUniverse,
  footballGridUniverseSnapshot,
  normalizeFootballGridAnswer,
  resolveFootballGridAnswer,
  type FootballGridNameUniverse,
  type FootballGridPlayerNameRecord,
} from '../../src/modules/football-grid/football-grid.answer-resolver.js';
import type { FootballGridAliasRecord } from '../../src/modules/football-grid/football-grid.types.js';
import { buildSoloBoardContent, resolveInCell } from '../../src/modules/football-grid/football-grid-solo.service.js';

// Invented footballers only: this repository is public.
const alias = (
  playerId: string,
  text: string,
  locale: FootballGridAliasRecord['locale'] = 'en',
  acceptancePolicy: FootballGridAliasRecord['acceptancePolicy'] = 'exact',
): FootballGridAliasRecord => ({
  id: `${playerId}:${locale}:${text}`, playerId, alias: text, normalizedAlias: normalizeFootballGridAnswer(text), locale, acceptancePolicy,
});

const byPlayer = (aliases: FootballGridAliasRecord[]) => {
  const map = new Map<string, FootballGridAliasRecord[]>();
  for (const a of aliases) map.set(a.playerId, [...(map.get(a.playerId) ?? []), a]);
  return map;
};

function resolver(input: {
  aliases: FootballGridAliasRecord[];
  valid: string[];
  board?: string[];
  names?: FootballGridPlayerNameRecord[];
  release?: FootballGridAliasRecord[];
}) {
  const aliases = input.aliases;
  const universe = input.release ? footballGridNameUniverse([byPlayer(input.release)]) : undefined;
  return (submittedText: string, usedPlayerIds: string[] = []) => resolveFootballGridAnswer({
    submittedText, aliases, validPlayerIds: input.valid, boardPlayerIds: input.board ?? input.valid, usedPlayerIds,
    validPlayerNames: input.names ?? [], universe,
  });
}

describe('typo veto: the text is another footballer of the release, as typed', () => {
  const board = [alias('jarvo', 'Jarvo Strelnik'), alias('jarvo', 'Strelnik', 'en', 'unique_only')];
  const release = [...board, alias('jovo', 'Jovo Strelnik'), alias('jovo', 'Strelnik', 'en', 'unique_only'), alias('kett', 'Marcel Ottavo')];
  const resolve = resolver({ aliases: board, valid: ['jarvo'], release });

  it('refuses a sibling or namesake one or two edits from the right answer', () => {
    expect(resolve('Jovo Strelnik')).toMatchObject({ outcome: 'wrong', playerId: null,
      diagnostics: { reason: 'recognized_not_in_cell', candidatePlayerIds: ['jovo'] } });
    expect(resolve('JOVO STRELNIK').outcome).toBe('wrong');
  });

  it('still forgives a slip that names nobody', () => {
    expect(resolve('Jarvo Strelnyk')).toMatchObject({ outcome: 'correct', playerId: 'jarvo' });
    expect(resolve('Jarvo Strelnik')).toMatchObject({ outcome: 'correct', playerId: 'jarvo' });
  });

  it('a name shared with a valid answer is no veto (the exact tier answers it)', () => {
    expect(resolve('Strelnik')).toMatchObject({ outcome: 'correct', playerId: 'jarvo' });
  });

  it('without a universe the board alone judges (the old behaviour)', () => {
    expect(resolver({ aliases: board, valid: ['jarvo'] })('Jovo Strelnik')).toMatchObject({ outcome: 'correct', playerId: 'jarvo' });
  });

  it('reads every release a board carries answers from', () => {
    const other = byPlayer([alias('nilo', 'Jarvo Strelnak')]);
    const universe = footballGridNameUniverse([byPlayer(release), other]);
    const ids = (name: string) => universe.holders(footballGridMatchKey(normalizeFootballGridAnswer(name))).map((holder) => holder.playerId);
    expect(ids('Jarvo Strelnak')).toEqual(['nilo']);
    expect(ids('Strelnik')).toEqual(['jarvo', 'jovo']);
    expect(ids('Nobody')).toEqual([]);
  });
});

describe('typos of a valid answer\'s published aliases (transliterations, nicknames)', () => {
  const aliases = [
    alias('teo', 'Teodor Varkelinen'),
    alias('teo', 'Теодор Варкелинен', 'ru'),
    alias('teo', 'თეოდორ ვარკელინენი', 'ka'),
    alias('teo', 'El Zorzal', 'es'),
    alias('teo', 'Teo', 'en'),
    alias('ruk', 'Rukso Partanen'),
  ];
  const resolve = resolver({ aliases, valid: ['teo'], board: ['teo', 'ruk'] });

  it('credits a one-edit slip in Russian, Georgian, or a nickname', () => {
    expect(resolve('Теодор Варкеллинен')).toMatchObject({ outcome: 'correct', playerId: 'teo' });
    expect(resolve('თეოდორ ვარკელინენ')).toMatchObject({ outcome: 'correct', playerId: 'teo' });
    expect(resolve('El Sorzal')).toMatchObject({ outcome: 'correct', playerId: 'teo' });
  });

  it('keeps short aliases exact-only', () => {
    expect(resolve('Teo')).toMatchObject({ outcome: 'correct', playerId: 'teo' });
    expect(resolve('Tea').outcome).toBe('wrong');
  });

  it('a slip nearer another board player\'s name is that player, not the right answer', () => {
    // Only near: a suggestion, never logged as an identification.
    expect(resolve('Rukso Partanan')).toMatchObject({ outcome: 'wrong', diagnostics: { reason: 'nearest_typo_not_in_cell', candidatePlayerIds: ['ruk'] } });
  });

  it('a slip as near another board player as the right answer asks for more', () => {
    const tie = resolver({ aliases: [alias('teo', 'Varkel'), alias('ruk', 'Varkol')], valid: ['teo'], board: ['teo', 'ruk'] });
    expect(tie('Varkal')).toMatchObject({ outcome: 'ambiguous', diagnostics: { reason: 'multiple_typo_candidates' } });
  });
});

describe('a name two valid answers share credits the best known one', () => {
  const aliases = [
    alias('ben', 'Bentro Mavendi'), alias('ben', 'Mavendi', 'en', 'unique_only'),
    alias('fer', 'Ferlo Mavendi'), alias('fer', 'Mavendi', 'en', 'unique_only'),
    alias('edu', 'Edvo Mavendi'), alias('edu', 'Mavendi', 'en', 'unique_only'),
  ];
  // Cell order is best known first: fer, then ben. edu is on the board in another cell.
  const resolve = resolver({ aliases, valid: ['fer', 'ben'], board: ['ben', 'fer', 'edu'] });

  it('credits the first of the cell\'s answers while none is used', () => {
    expect(resolve('Mavendi')).toMatchObject({ outcome: 'correct', playerId: 'fer',
      diagnostics: { reason: 'accepted', cellCandidateCount: 2 } });
  });

  it('asks for more once one of them is used, and says used when all are', () => {
    expect(resolve('Mavendi', ['fer'])).toMatchObject({ outcome: 'ambiguous', playerId: null,
      diagnostics: { reason: 'multiple_cell_candidates' } });
    expect(resolve('Mavendi', ['ben'])).toMatchObject({ outcome: 'ambiguous' });
    expect(resolve('Mavendi', ['ben', 'fer'])).toMatchObject({ outcome: 'already_used', playerId: 'fer' });
  });

  it('a full name still names exactly its footballer', () => {
    expect(resolve('Bentro Mavendi')).toMatchObject({ outcome: 'correct', playerId: 'ben' });
    expect(resolve('Bentro Mavendi', ['fer'])).toMatchObject({ outcome: 'correct', playerId: 'ben' });
    expect(resolve('Edvo Mavendi')).toMatchObject({ outcome: 'wrong', diagnostics: { reason: 'recognized_not_in_cell' } });
  });

  it('a typo near two valid answers credits the best known; near a non-cell player too, it asks for more', () => {
    // edu, in another cell, answers to "Mavendi" as well.
    expect(resolve('Mavendy')).toMatchObject({ outcome: 'ambiguous' });
    const mixed = resolver({ aliases: [alias('fer', 'Kolvarin'), alias('ben', 'Kolvaran'), alias('edu', 'Kolvaron')],
      valid: ['fer', 'ben'], board: ['fer', 'ben', 'edu'] });
    expect(mixed('Kolvarun')).toMatchObject({ outcome: 'ambiguous', diagnostics: { reason: 'multiple_typo_candidates' } });
    expect(resolver({ aliases: [alias('fer', 'Kolvarin'), alias('ben', 'Kolvaran')], valid: ['fer', 'ben'], board: ['fer', 'ben'] })('Kolvarun'))
      .toMatchObject({ outcome: 'correct', playerId: 'fer' });
  });

  it('a surname only another board player holds still falls through to the cell\'s own name forms', () => {
    const fallThrough = resolver({ aliases: [alias('edu', 'Quorrin', 'en', 'unique_only')], valid: ['ziv'], board: ['ziv', 'edu'],
      names: [{ playerId: 'ziv', nameEn: 'Ziv Quorrin', nameKa: null }] });
    expect(fallThrough('Quorrin')).toMatchObject({ outcome: 'correct', playerId: 'ziv', diagnostics: { method: 'name_form' } });
  });
});

describe('letters NFD cannot strip', () => {
  it.each([
    ['Ødvik Strånd', 'Odvik Strand'],
    ['Łukarz Wendołek', 'Lukarz Wendolek'],
    ['Đorvan Kelić', 'Dorvan Kelic'],
    ['Sæverin Holt', 'Saeverin Holt'],
    ['Þorvin Gestr', 'Thorvin Gestr'],
    ['Jan–Piet Rovel', 'Jan Piet Rovel'],
  ])('%s is accepted typed as %s', (published, typed) => {
    const resolve = resolver({ aliases: [alias('p', published)], valid: ['p'] });
    expect(resolve(typed)).toMatchObject({ outcome: 'correct', playerId: 'p', diagnostics: { method: 'orthographic' } });
  });

  it('an exact spelling still outranks a folded one', () => {
    const resolve = resolver({ aliases: [alias('a', 'Mollo'), alias('b', 'Møllo')], valid: ['b'], board: ['a', 'b'] });
    expect(resolve('Mollo')).toMatchObject({ outcome: 'wrong', diagnostics: { reason: 'recognized_not_in_cell' } });
    expect(resolve('Møllo')).toMatchObject({ outcome: 'correct', playerId: 'b', diagnostics: { method: 'exact' } });
  });
});

describe('daily grid content', () => {
  const answers = [
    { cellIndex: 0, footballPlayerId: 'fer', playerNameEn: 'Ferlo Mavendi', playerNameKa: null, playerNameRu: null },
    { cellIndex: 0, footballPlayerId: 'ben', playerNameEn: 'Bentro Mavendi', playerNameKa: null, playerNameRu: null },
  ];
  const own = byPlayer([alias('fer', 'Ferlo Mavendi'), alias('ben', 'Bentro Mavendi'), alias('sib', 'Ferro Mavendi')]);
  const carriedRelease = byPlayer([alias('kar', 'Karvo Lindt'), alias('kin', 'Karvi Lindt')]);
  const content = buildSoloBoardContent({
    answers, aliasesByPlayer: own,
    carried: [{ cellIndex: 1, playerId: 'kar', releaseId: 'r2', nameEn: 'Karvo Lindt', nameKa: null, nameRu: null, imageUrl: null }],
    carriedAliasesByRelease: new Map([['r2', carriedRelease]]),
  });

  it('vetoes typos against the board release and the carried releases', () => {
    expect(resolveInCell(content, 0, 'Ferro Mavendi').outcome).toBe('wrong');
    expect(resolveInCell(content, 1, 'Karvi Lindt').outcome).toBe('wrong');
    expect(resolveInCell(content, 1, 'Karvo Lint')).toMatchObject({ outcome: 'correct', playerId: 'kar' });
  });

  it('judges a shared surname with the run\'s used footballers', () => {
    expect(resolveInCell(content, 0, 'Mavendi')).toMatchObject({ outcome: 'correct', playerId: 'fer' });
    expect(resolveInCell(content, 0, 'Mavendi', ['fer']).outcome).toBe('ambiguous');
  });
});

describe('swapped letters and surname-first order', () => {
  it('reads two swapped neighbouring letters as one slip', () => {
    expect(boundedTypoDistance('tavron', 'tarvon', 1)).toBe(1);
    expect(boundedTypoDistance('tavron', 'tarvno', 1)).toBe(2);
    expect(resolver({ aliases: [alias('t', 'Tarvon')], valid: ['t'] })('Tavron')).toMatchObject({ outcome: 'correct', playerId: 't' });
  });

  it('accepts a valid answer\'s name with its words reversed, in any script', () => {
    const resolve = resolver({ aliases: [alias('y', 'Yorvo Telmanen'), alias('y', 'Йорво Телманен', 'ru'), alias('z', 'Kesto Arvalin')],
      valid: ['y'], board: ['y', 'z'] });
    expect(resolve('Телманен Йорво')).toMatchObject({ outcome: 'correct', playerId: 'y', diagnostics: { method: 'word_order' } });
    expect(resolve('Telmanen Yorvo')).toMatchObject({ outcome: 'correct', playerId: 'y' });
    expect(resolve('Arvalin Kesto')).toMatchObject({ outcome: 'wrong', diagnostics: { reason: 'recognized_not_in_cell' } });
  });

  it('never reorders into a match when the text is another footballer\'s name as typed', () => {
    const resolve = resolver({ aliases: [alias('y', 'Marlo Teven')], valid: ['y'], release: [alias('y', 'Marlo Teven'), alias('o', 'Teven Marlo')] });
    expect(resolve('Teven Marlo')).toMatchObject({ outcome: 'wrong', diagnostics: { candidatePlayerIds: ['o'] } });
  });
});

describe('footballers beyond the Grid release', () => {
  const everyone: FootballGridNameUniverse = (() => {
    const index = footballGridNameIndex([{ playerId: 'far', normalized: normalizeFootballGridAnswer('Delvin Oskaro') }]);
    return { holders: (key) => index.get(key) ?? [] };
  })();

  it('vetoes a typo that is exactly the name of a footballer no Grid release knows', () => {
    const universe = footballGridNameUniverse([byPlayer([])], everyone);
    const resolve = (text: string) => resolveFootballGridAnswer({ submittedText: text, aliases: [alias('v', 'Delvan Oskaro')],
      validPlayerIds: ['v'], boardPlayerIds: ['v'], usedPlayerIds: [], validPlayerNames: [], universe });
    expect(resolve('Delvin Oskaro')).toMatchObject({ outcome: 'wrong', diagnostics: { reason: 'recognized_not_in_cell', candidatePlayerIds: ['far'] } });
    expect(resolve('Delvin Oskaru')).toMatchObject({ outcome: 'correct', playerId: 'v' });
  });

  it('vetoes that name typed surname first too, and still credits the right answer in either order', () => {
    const universe = footballGridNameUniverse([byPlayer([])], everyone);
    const resolve = (text: string) => resolveFootballGridAnswer({ submittedText: text,
      aliases: [alias('v', 'Delvan Oskaro'), alias('v', 'Oskaro Delvan')],
      validPlayerIds: ['v'], boardPlayerIds: ['v'], usedPlayerIds: [], validPlayerNames: [], universe });
    expect(resolve('Oskaro Delvin')).toMatchObject({ outcome: 'wrong', diagnostics: { reason: 'recognized_not_in_cell', candidatePlayerIds: ['far'] } });
    expect(resolve('Delvin Oskaro')).toMatchObject({ outcome: 'wrong' });
    expect(resolve('Oskaro Delvan')).toMatchObject({ outcome: 'correct', playerId: 'v' });
    expect(resolve('Delvan Oskaro')).toMatchObject({ outcome: 'correct', playerId: 'v' });
  });

  it('a Russian full name read two ways credits the best-known right answer', () => {
    const resolve = (text: string) => resolveFootballGridAnswer({ submittedText: text,
      aliases: [alias('a', 'Николай Радович Кеттл', 'ru'), alias('b', 'Николай Петрович Кеттл', 'ru')],
      validPlayerIds: ['b', 'a'], boardPlayerIds: ['a', 'b'], usedPlayerIds: [], validPlayerNames: [] });
    expect(resolve('Николай Петрович Радович Кеттл')).toMatchObject({ outcome: 'correct', playerId: 'b' });
    // One reading already played, the other not: as for a shared name, that is ambiguous.
    const withUsed = resolveFootballGridAnswer({ submittedText: 'Николай Петрович Радович Кеттл',
      aliases: [alias('a', 'Николай Радович Кеттл', 'ru'), alias('b', 'Николай Петрович Кеттл', 'ru')],
      validPlayerIds: ['b', 'a'], boardPlayerIds: ['a', 'b'], usedPlayerIds: ['b'], validPlayerNames: [] });
    expect(withUsed).toMatchObject({ outcome: 'ambiguous', playerId: null });
  });

  it('vetoes a four-word name in any order', () => {
    const index = footballGridNameIndex([{ playerId: 'far4', normalized: normalizeFootballGridAnswer('Tavo Elmer Dorin Vasko') }]);
    const universe = footballGridNameUniverse([byPlayer([])], { holders: (key) => index.get(key) ?? [] });
    const resolve = (text: string) => resolveFootballGridAnswer({ submittedText: text, aliases: [alias('v', 'Tavu Elmer Vasko Dorin')],
      validPlayerIds: ['v'], boardPlayerIds: ['v'], usedPlayerIds: [], validPlayerNames: [], universe });
    expect(resolve('Tavo Elmer Vasko Dorin')).toMatchObject({ outcome: 'wrong', diagnostics: { candidatePlayerIds: ['far4'] } });
    expect(resolve('Tavu Elmer Vasko Dorin')).toMatchObject({ outcome: 'correct', playerId: 'v' });
  });
});

describe('review regressions', () => {
  it('a name only a valid player\'s other release knows is that player, not a typo of another valid one', () => {
    const universe = footballGridNameUniverse([byPlayer([alias('a', 'Varlin')]), byPlayer([alias('b', 'Varlen')])]);
    const resolve = (used: string[]) => resolveFootballGridAnswer({ submittedText: 'Varlen', aliases: [alias('a', 'Varlin')],
      validPlayerIds: ['a', 'b'], boardPlayerIds: ['a', 'b'], usedPlayerIds: used, validPlayerNames: [], universe });
    expect(resolve([])).toMatchObject({ outcome: 'correct', playerId: 'b' });
    expect(resolve(['b'])).toMatchObject({ outcome: 'already_used', playerId: 'b' });
  });

  it('an exact name of a footballer off the board beats a folded spelling of a valid one', () => {
    const universe = footballGridNameUniverse([byPlayer([alias('v', 'Møllo'), alias('x', 'Mollo')])]);
    const resolve = (text: string) => resolveFootballGridAnswer({ submittedText: text, aliases: [alias('v', 'Møllo')],
      validPlayerIds: ['v'], boardPlayerIds: ['v'], usedPlayerIds: [], validPlayerNames: [], universe });
    expect(resolve('Mollo')).toMatchObject({ outcome: 'wrong', diagnostics: { candidatePlayerIds: ['x'] } });
    expect(resolve('Møllo')).toMatchObject({ outcome: 'correct', playerId: 'v' });
  });

  it('reads aliases and name forms together, so ranking and used players see every namesake', () => {
    const names = [
      { playerId: 'a', nameEn: 'Arvo Mavendi', nameKa: null },
      { playerId: 'b', nameEn: 'Bero Mavendi', nameKa: null },
      { playerId: 'c', nameEn: 'Cato Mavendi', nameKa: null },
    ];
    const aliases = [alias('a', 'Arvo Mavendi'), alias('b', 'Mavendi', 'en', 'unique_only'), alias('c', 'Mavendi', 'en', 'unique_only')];
    const resolve = (used: string[]) => resolveFootballGridAnswer({ submittedText: 'Mavendi', aliases, validPlayerIds: ['a', 'b', 'c'],
      boardPlayerIds: ['a', 'b', 'c'], usedPlayerIds: used, validPlayerNames: names });
    expect(resolve([])).toMatchObject({ outcome: 'correct', playerId: 'a' });
    expect(resolve(['a']).outcome).toBe('ambiguous');
    expect(resolve(['b', 'c']).outcome).toBe('ambiguous');
    expect(resolve(['a', 'b', 'c'])).toMatchObject({ outcome: 'already_used', playerId: 'a' });
  });

  it('short names and name forms of other board players compete for a typo', () => {
    expect(resolver({ aliases: [alias('v', 'Lunnoa'), alias('o', 'Luno')], valid: ['v'], board: ['v', 'o'] })('Lunno').outcome)
      .toBe('ambiguous');
    const boardPlayerNames = [{ playerId: 'v', nameEn: 'Tamo Varlin', nameKa: null }, { playerId: 'o', nameEn: 'Kero Varlen', nameKa: null }];
    const resolve = (text: string) => resolveFootballGridAnswer({ submittedText: text, aliases: [alias('v', 'Varlin')],
      validPlayerIds: ['v'], boardPlayerIds: ['v', 'o'], usedPlayerIds: [], validPlayerNames: [boardPlayerNames[0]], boardPlayerNames });
    expect(resolve('Varlen')).toMatchObject({ outcome: 'wrong', diagnostics: { reason: 'recognized_not_in_cell', candidatePlayerIds: ['o'] } });
    expect(resolve('Varlinn')).toMatchObject({ outcome: 'correct', playerId: 'v' });
  });

  it('a right answer\'s short name nearest the text blocks a typo credit to another right answer', () => {
    expect(resolver({ aliases: [alias('v', 'Lunnoa'), alias('w', 'Luno')], valid: ['v', 'w'] })('Lunno').outcome).toBe('ambiguous');
  });

  it('reads a reordered name as typed before its folded spelling', () => {
    const resolve = resolver({ aliases: [alias('a', 'Arvo Møllo'), alias('b', 'Arvo Mollo')], valid: ['a', 'b'] });
    expect(resolve('Mollo Arvo')).toMatchObject({ outcome: 'correct', playerId: 'b', diagnostics: { method: 'word_order' } });
    expect(resolve('Møllo Arvo')).toMatchObject({ outcome: 'correct', playerId: 'a' });
  });

  it('a universe snapshot answers one command the same way however the source changes', () => {
    let names: FootballGridNameUniverse['holders'] = () => [];
    const snapshot = footballGridUniverseSnapshot({ holders: (key) => names(key) });
    expect(snapshot.holders('kesto')).toEqual([]);
    names = () => [{ playerId: 'late', raw: 'kesto' }];
    expect(snapshot.holders('kesto')).toEqual([]);
  });
});

describe('Russian names with a patronymic or a middle name', () => {
  const resolve = resolver({ aliases: [alias('n', 'Николай Тарвенко', 'ru'), alias('z', 'Зорин Кеттл', 'ru')], valid: ['n'], board: ['n', 'z'] });

  it('reads the passport form without the middle name, in either order', () => {
    expect(resolve('Николай Петрович Тарвенко')).toMatchObject({ outcome: 'correct', playerId: 'n' });
    expect(resolve('Тарвенко Николай Петрович')).toMatchObject({ outcome: 'correct', playerId: 'n', diagnostics: { method: 'word_order' } });
    expect(resolve('Николай Барселлос Тарвенко')).toMatchObject({ outcome: 'correct', playerId: 'n' });
  });

  it('leaves out one patronymic-looking word at a time, so a surname that looks like one survives', () => {
    const kettl = resolver({ aliases: [alias('k', 'Николай Радович Кеттл', 'ru')], valid: ['k'] });
    expect(kettl('Николай Петрович Радович Кеттл')).toMatchObject({ outcome: 'correct', playerId: 'k' });
    expect(kettl('Николай Радович Кеттл')).toMatchObject({ outcome: 'correct', playerId: 'k', diagnostics: { method: 'exact' } });
  });

  it('never adds a typo on top of the shortened text, and another player stays another player', () => {
    expect(resolve('Николай Петрович Тарвенка').outcome).toBe('wrong');
    expect(resolve('Зорин Иванович Кеттл')).toMatchObject({ outcome: 'wrong', diagnostics: { reason: 'recognized_not_in_cell' } });
  });
});
