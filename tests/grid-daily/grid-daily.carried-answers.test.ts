import { describe, expect, it } from 'vitest';
import { normalizeFootballGridAnswer } from '../../src/modules/football-grid/football-grid.answer-resolver.js';
import type { FootballGridCarriedAnswer } from '../../src/modules/football-grid/football-grid-carried-answers.js';
import { assertRefusalJudgeable, buildSoloBoardContent, resolveInCell } from '../../src/modules/football-grid/football-grid-solo.service.js';
import type { FootballGridAliasRecord } from '../../src/modules/football-grid/football-grid.types.js';

/**
 * The tester's report: "Júlio Baptista" refused twice for AS Roma × La Liga on a daily grid. The board was dealt
 * from a release whose Roma clue only knew post-2012 appearances; a reviewed correction (Roma 2008–11) lands in a
 * newer release, and the daily board, frozen with its own release, must accept him from then on.
 */
const BOARD_RELEASE = 'release-board';
const NEWER_RELEASE = 'release-corrected';
const baptista = '7aa111e1-1c65-481c-9612-4da8c3dbf283';
const julioCesar = '80bcb2d4-bfbd-4ef8-85ec-44925ecebe79';
const totti = 'totti';
const ROMA_X_LALIGA = 0;
const MALAGA_X_BRAZIL = 4;

const alias = (playerId: string, text: string, acceptancePolicy: FootballGridAliasRecord['acceptancePolicy'] = 'exact', locale: FootballGridAliasRecord['locale'] = 'en'): FootballGridAliasRecord =>
  ({ id: `${playerId}:${text}`, playerId, alias: text, normalizedAlias: normalizeFootballGridAnswer(text), locale, acceptancePolicy });
const baptistaAliases = [alias(baptista, 'Júlio Baptista'), alias(baptista, 'Baptista', 'unique_only'), alias(baptista, 'ჟულიო ბაპტისტა', 'exact', 'ka')];

/** The board's own answers: Baptista is on it, but only for Málaga × Brazil. */
const answers = [
  { cellIndex: ROMA_X_LALIGA, footballPlayerId: totti, playerNameEn: 'Francesco Totti', playerNameKa: null, playerNameRu: null },
  { cellIndex: ROMA_X_LALIGA, footballPlayerId: julioCesar, playerNameEn: 'Júlio César', playerNameKa: null, playerNameRu: null },
  { cellIndex: MALAGA_X_BRAZIL, footballPlayerId: baptista, playerNameEn: 'Júlio Baptista', playerNameKa: 'ჟულიო ბაპტისტა', playerNameRu: null },
];
const aliasesByPlayer = new Map([[baptista, baptistaAliases], [julioCesar, [alias(julioCesar, 'Júlio César')]], [totti, [alias(totti, 'Francesco Totti')]]]);
const carriedBaptista: FootballGridCarriedAnswer = {
  cellIndex: ROMA_X_LALIGA, playerId: baptista, releaseId: NEWER_RELEASE, nameEn: 'Júlio Baptista', nameKa: 'ჟულიო ბაპტისტა', nameRu: null, imageUrl: 'https://img/baptista.webp',
};

describe('daily grid: answers a board did not have when it was dealt', () => {
  it('reproduces the report: the board alone refuses Baptista for AS Roma × La Liga', () => {
    const content = buildSoloBoardContent({ answers, aliasesByPlayer });
    for (const text of ['Júlio Baptista', 'Julio Baptista', 'Baptista']) {
      expect(resolveInCell(content, ROMA_X_LALIGA, text)).toMatchObject({ outcome: 'wrong', diagnostics: { reason: 'recognized_not_in_cell' } });
    }
  });

  it('accepts him once a published release holds both his Roma and La Liga memberships', () => {
    const content = buildSoloBoardContent({ answers, aliasesByPlayer, carried: [carriedBaptista], carriedAliasesByRelease: new Map([[NEWER_RELEASE, new Map([[baptista, baptistaAliases]])]]) });
    for (const text of ['Júlio Baptista', 'Julio Baptista', 'julio baptista', 'Baptista', 'ჟულიო ბაპტისტა']) {
      expect(resolveInCell(content, ROMA_X_LALIGA, text)).toMatchObject({ outcome: 'correct', playerId: baptista });
    }
    // Nothing the board had is lost, and nobody else is picked for his name.
    expect(resolveInCell(content, ROMA_X_LALIGA, 'Júlio César')).toMatchObject({ outcome: 'correct', playerId: julioCesar });
    expect(resolveInCell(content, ROMA_X_LALIGA, 'Totti')).toMatchObject({ outcome: 'correct', playerId: totti });
    expect(resolveInCell(content, MALAGA_X_BRAZIL, 'Baptista')).toMatchObject({ outcome: 'correct', playerId: baptista });
    expect(content.validPlayerIdsByCell.get(ROMA_X_LALIGA)).toEqual([totti, julioCesar, baptista]);
    // A board player keeps the names the board shows; the same alias from two releases is listed once.
    expect(content.boardPlayerIds.filter((id) => id === baptista)).toHaveLength(1);
    expect(content.aliases.filter((a) => a.playerId === baptista)).toHaveLength(baptistaAliases.length);
  });

  it('a footballer new to the board is read with the aliases of the release that holds him, and shown with its portrait', () => {
    const content = buildSoloBoardContent({
      answers: answers.filter((answer) => answer.footballPlayerId !== baptista),
      aliasesByPlayer,
      carried: [carriedBaptista],
      carriedAliasesByRelease: new Map([[NEWER_RELEASE, new Map([[baptista, baptistaAliases]])]]),
    });
    expect(resolveInCell(content, ROMA_X_LALIGA, 'Baptista')).toMatchObject({ outcome: 'correct', playerId: baptista });
    expect(content.namesById.get(baptista)).toMatchObject({ nameEn: 'Júlio Baptista', nameKa: 'ჟულიო ბაპტისტა', imageUrl: 'https://img/baptista.webp' });
    // Without that release's aliases his displayed name still reads (the cell's own name forms).
    const noAliases = buildSoloBoardContent({ answers: answers.filter((answer) => answer.footballPlayerId !== baptista), aliasesByPlayer, carried: [carriedBaptista] });
    expect(resolveInCell(noAliases, ROMA_X_LALIGA, 'Júlio Baptista')).toMatchObject({ outcome: 'correct', playerId: baptista });
    expect(resolveInCell(noAliases, MALAGA_X_BRAZIL, 'Júlio Baptista').outcome).toBe('wrong');
  });

  it('a carried answer only fits its own cell', () => {
    const content = buildSoloBoardContent({ answers, aliasesByPlayer, carried: [carriedBaptista] });
    expect(resolveInCell(content, 1, 'Baptista').outcome).toBe('wrong');
  });

  it('a board player carried into another cell is also read with an alias only the correcting release has', () => {
    // The board's release knows him as "Júlio Baptista" only; the correction adds "Baptista" with the Roma spell.
    const own = new Map(aliasesByPlayer);
    own.set(baptista, [alias(baptista, 'Júlio Baptista')]);
    const before = buildSoloBoardContent({ answers, aliasesByPlayer: own });
    expect(resolveInCell(before, MALAGA_X_BRAZIL, 'Baptista Júlio').outcome).toBe('wrong');
    const content = buildSoloBoardContent({
      answers, aliasesByPlayer: own, carried: [carriedBaptista],
      carriedAliasesByRelease: new Map([[NEWER_RELEASE, new Map([[baptista, [...baptistaAliases, alias(baptista, 'Baptista Júlio', 'unique_only')]]])]]),
    });
    expect(resolveInCell(content, ROMA_X_LALIGA, 'Baptista Júlio')).toMatchObject({ outcome: 'correct', playerId: baptista });
    expect(resolveInCell(content, MALAGA_X_BRAZIL, 'Baptista Júlio')).toMatchObject({ outcome: 'correct', playerId: baptista });
    expect(content.aliases.filter((a) => a.playerId === baptista && a.normalizedAlias === 'julio baptista')).toHaveLength(1);
  });

  it('content without the carried answers never hands out a refusal', () => {
    expect(() => assertRefusalJudgeable({ incomplete: true })).toThrow(/temporarily unavailable/);
    expect(() => assertRefusalJudgeable(buildSoloBoardContent({ answers, aliasesByPlayer }))).not.toThrow();
  });

  it('a correcting release that made an alias a safe typo target still forgives typos in the carried cell', () => {
    const ronaldinho = 'ronaldinho';
    // Not on the board; the board's release knows "Ronaldinho" as exact only, the correction as a safe typo target.
    const own = new Map(aliasesByPlayer);
    own.set(ronaldinho, [alias(ronaldinho, 'Ronaldinho')]);
    const carried: FootballGridCarriedAnswer = { cellIndex: ROMA_X_LALIGA, playerId: ronaldinho, releaseId: NEWER_RELEASE,
      nameEn: 'Ronaldo de Assis Moreira', nameKa: null, nameRu: null, imageUrl: null };
    const content = buildSoloBoardContent({
      answers, aliasesByPlayer: own, carried: [carried],
      carriedAliasesByRelease: new Map([[NEWER_RELEASE, new Map([[ronaldinho, [alias(ronaldinho, 'Ronaldinho', 'safe_typo')]]])]]),
    });
    expect(resolveInCell(content, ROMA_X_LALIGA, 'Ronaldinho')).toMatchObject({ outcome: 'correct', playerId: ronaldinho });
    expect(resolveInCell(content, ROMA_X_LALIGA, 'Ronaldiho')).toMatchObject({ outcome: 'correct', playerId: ronaldinho });
    // Both policies are kept; the board's own cells still read the board's aliases (Baptista's exact names).
    expect(content.aliases.filter((a) => a.playerId === ronaldinho).map((a) => a.acceptancePolicy).sort()).toEqual(['exact', 'safe_typo']);
    expect(resolveInCell(content, MALAGA_X_BRAZIL, 'Júlio Baptista')).toMatchObject({ outcome: 'correct', playerId: baptista });
  });
});
