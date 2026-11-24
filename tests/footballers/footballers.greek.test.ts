import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const db = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('../../src/db/index.js', () => ({ sql: db.sql }));

import { LoadFirst } from '../../src/modules/daily/daily.service.js';
import { footballersService } from '../../src/modules/footballers/footballers.service.js';
import { forgetGreek, greekIndex, greekView, heldGreekIndex, roomGreekView } from '../../src/modules/footballers/footballers.greek.js';
import { judgingUniverse, RoomContentUnavailable } from '../../src/modules/footballers/footballers.overlay.js';
import { russianView } from '../../src/modules/footballers/footballers.russian.js';
import {
  firstLetterGreek, isCyrillicText, isGreekText, lastLetterGreek, normalizeName, normalizeNameCyrillic, normalizeNameGreek, normalizeTyped, surnameOfGreek,
} from '../../src/modules/footballers/footballers.text.js';
import { buildGreekIndex, buildRussianIndex, buildUniverse, type UniversePlayer } from '../../src/modules/footballers/footballers.universe.js';
import * as chain from '../../src/modules/name-chain-daily/name-chain-daily.rules.js';
import { startMatch } from '../../src/modules/room/games/name-chain/name-chain.engine.js';
import { nameChainRoomEngine as roomEngine } from '../../src/modules/room/games/name-chain/name-chain.room.js';
import { sharedPlayerRoomEngine } from '../../src/modules/room/games/shared-player/shared-player.room.js';
import { judgingOf, startMatch as startPairs } from '../../src/modules/room/games/shared-player/shared-player.engine.js';
import * as pairs from '../../src/modules/shared-player-daily/shared-player-daily.rules.js';
import { frozenUniverse } from '../../src/modules/wordgame-daily/wordgame-daily.shared.js';
import { refusedForPair, refusedName } from '../../src/modules/wordgame-reports/wordgame-reports.rules.js';

// Invented footballers and invented Greek spellings only: the repository is public.
const P = (pid: string, name: string, game: string, fame: number, aliases: string[] = []): UniversePlayer => ({ pid, name, game, fame, aliases });
const release = buildUniverse('rel-1', [
  P('p-orlen', 'Tarin Orlen', 'Orlen', 80), P('p-nesto', 'Nesto Valdi', 'Nesto', 60), P('p-kosel', 'Emir Kosel', 'Kosel', 50), P('p-sarko', 'Sarko', 'Sarko', 40),
]);
const greekNames = buildGreekIndex('el-1', [
  P('p-orlen', 'Ταρίν Όρλεν', 'Όρλεν', 80, ['Τάριν Όρλεν']),
  P('p-nesto', 'Νέστο Βάλντι', 'Νέστος', 60, ['Νέστωρ']),
  P('p-sarko', 'Σάρκο', 'Σάρκο', 40),
  // Not in the release: never answerable through it.
  P('p-elsewhere', 'Άλκης Μύρος', 'Μύρος', 90),
]);
const russianNames = buildRussianIndex('ru-1', [P('p-orlen', 'Тарин Орлен', 'Орлен', 80), P('p-nesto', 'Несто Валди', 'Несто', 60)]);
const greek = greekView(release, greekNames);
const russian = russianView(release, russianNames);

describe('Greek name text', () => {
  it('drops accents and dialytika, reads either sigma as σ and ignores case', () => {
    expect(normalizeNameGreek('Ταρίν ΌΡΛΕΝ')).toBe('ταριν ορλεν');
    expect(normalizeNameGreek('Νέστος')).toBe(normalizeNameGreek('ΝΕΣΤΟΣ'));
    expect(normalizeNameGreek('Νέστος')).toBe('νεστοσ');
    expect(normalizeNameGreek('Ϊάκο  Λαΐδης-Β.')).toBe('ιακο λαιδησ β');
  });

  it('tells Greek text apart and normalises each alphabet with its own reader', () => {
    expect(isGreekText('Νέστος')).toBe(true);
    expect(isGreekText('Nesto')).toBe(false);
    expect(isCyrillicText('Νέστος')).toBe(false);
    expect(normalizeTyped('  Νέστος ')).toBe('νεστοσ');
    expect(normalizeTyped('Орлен')).toBe(normalizeNameCyrillic('Орлен'));
    expect(normalizeTyped('Örlen')).toBe(normalizeName('Örlen'));
  });

  it('reads letters in the Greek alphabet, upper-case and without accents', () => {
    expect(firstLetterGreek('Όρλεν')).toBe('Ο');
    expect(lastLetterGreek('Νέστος')).toBe('Σ');
    expect(lastLetterGreek('Σάρκο')).toBe('Ο');
    expect(surnameOfGreek('Νέστο Βάλντι Τζούνιορ')).toBe('βαλντι');
  });

  it('indexes full name, known name and every Greek alternative spelling', () => {
    expect(greekNames.resolve('Νεστωρ')).toEqual(['p-nesto']);
    expect(greekNames.resolve('ταριν ορλεν')).toEqual(['p-orlen']);
    expect(greekNames.alphabet[0]).toBe('Α');
    expect(greekNames.alphabet).toContain('Ω');
    expect(greekNames.starts('p-nesto')).toEqual(expect.arrayContaining(['Ν', 'Β']));
    expect(greekNames.last('p-nesto')).toBe('Σ');
  });
});

describe('judging with Greek names', () => {
  it('reads Greek text through the Greek view, Cyrillic through the Russian one and Latin exactly as before', () => {
    const judging = judgingUniverse(release, russian, 'latin', greek);
    expect(judging.resolve('Όρλεν')).toEqual(['p-orlen']);
    expect(judging.resolve('Орлен')).toEqual(['p-orlen']);
    expect(judging.resolve('Orlen')).toEqual(release.resolve('Orlen'));
    expect(judging.resolve('Μύρος')).toEqual([]);
    expect(judging.pickAmong('Νέστωρ', ['p-nesto', 'p-orlen'])).toBe('p-nesto');
    expect(judging.named('Σαρκο')).toEqual(['p-sarko']);
    expect(judging.last('p-orlen')).toBe(release.last('p-orlen'));
    expect(judging.player('p-orlen')?.name).toBe('Tarin Orlen');
  });

  it('without a Greek view, Greek text reads as it did before (nothing), and the Russian-only view is unchanged', () => {
    const russianOnly = judgingUniverse(release, russian, 'latin');
    expect(russianOnly.resolve('Όρλεν')).toEqual([]);
    expect(russianOnly.resolve('Орлен')).toEqual(['p-orlen']);
    expect(judgingUniverse(release, russian, 'latin', null)).toBe(russianOnly);
    expect(judgingUniverse(release, null, 'greek', null)).toBe(release);
  });

  it('plays Greek letters and shows Greek names on the Greek alphabet', () => {
    const letters = judgingUniverse(release, null, 'greek', greek);
    expect(letters.alphabet[0]).toBe('Α');
    expect(letters.last('p-orlen')).toBe('Ν');
    expect(letters.player('p-orlen')?.name).toBe('Ταρίν Όρλεν');
    // A footballer without a Greek name keeps his Latin name and has no Greek letter.
    expect(letters.player('p-kosel')?.name).toBe('Emir Kosel');
    expect(letters.starts('p-kosel')).toEqual([]);
    // A Latin answer still names the footballer; his Greek letters decide whether it fits.
    expect(letters.resolve('Nesto')).toEqual(['p-nesto']);
  });

  it('a run that froze nothing is the release itself', async () => {
    expect(await frozenUniverse(release, {}, 'latin', false)).toBe(release);
  });
});

describe('a Greek-letter name chain', () => {
  it('a daily run freezes the Greek names on, and Greek letters only when it started in Greek', () => {
    expect(chain.newState({ locale: 'el', greekVersion: 'el-1', russianVersion: 'ru-1' })).toMatchObject({ oe: 'el-1', ov: 'ru-1', al: 'gr' });
    expect(chain.newState({ locale: 'ru', greekVersion: 'el-1', russianVersion: 'ru-1' })).toMatchObject({ oe: 'el-1', ov: 'ru-1', al: 'cy' });
    expect(chain.newState({ locale: 'en', greekVersion: 'el-1' }).al).toBeUndefined();
    expect(chain.newState({ locale: 'el', greekVersion: null })).not.toHaveProperty('al');
    expect(chain.rebase({ ...chain.newState({ locale: 'el', greekVersion: 'el-1' }), c: 2 })).toMatchObject({ c: 0, oe: 'el-1', al: 'gr' });
  });

  it('a run without the new fields is exactly as before', () => {
    const old = chain.newState({ locale: 'ru', russianVersion: 'ru-1' });
    expect(old).not.toHaveProperty('oe');
    expect(chain.alphabetOf(old)).toBe('cyrillic');
    expect(chain.alphabetOf(chain.newState())).toBe('latin');
    expect(chain.newState()).toEqual(chain.newState({ locale: 'el' }));
  });

  it('chains on Greek letters, taking Greek, accent-free and Latin answers', () => {
    const universe = judgingUniverse(release, null, 'greek', greek);
    const s: chain.RunState = { ...chain.newState({ locale: 'el', greekVersion: 'el-1' }), open: true, dl: 10_000, letter: 'Ν', ch: [{ p: 'p-orlen', g: true }], used: ['p-orlen'] };
    const ok = chain.answer(s, universe, 1, 'ΝΕΣΤΩΡ', 5_000);
    expect(ok.result).toBe('ok');
    expect(ok.state.letter).toBe('Σ');
    expect(chain.answer(ok.state, universe, 1, 'Σαρκο', 6_000).result).toBe('ok');
    expect(chain.answer(s, universe, 1, 'Nesto Valdi', 5_000).result).toBe('ok');
    expect(chain.answer(s, universe, 1, 'Σάρκο', 5_000).result).toBe('letter');
    const shown = chain.publicState(ok.state, '2026-11-17', universe, 5_000, { ranked: false });
    expect(shown.alphabet).toBe('greek');
    expect(shown.links.map((l) => l.name)).toEqual(['Ταρίν Όρλεν', 'Νέστο Βάλντι']);
  });

  it('a room plays Greek letters only when every admitted player plays in Greek', () => {
    expect(startMatch(2, 0, { locales: ['el', 'el'], russianVersion: null, greekVersion: 'el-1' })).toMatchObject({ oe: 'el-1', al: 'gr' });
    expect(startMatch(2, 0, { locales: ['el', 'en'], russianVersion: null, greekVersion: 'el-1' }).al).toBeUndefined();
    expect(startMatch(2, 0, { locales: ['el', 'el'], russianVersion: 'ru-1', greekVersion: null })).not.toHaveProperty('al');
    expect(startMatch(2, 0, { locales: ['ru', 'ru'], russianVersion: 'ru-1' })).not.toHaveProperty('oe');
  });
});

describe('played for both with Greek names', () => {
  const pair = { a: { key: 'club-a' }, b: { key: 'club-b' }, accepted: ['p-nesto', 'p-orlen'] };

  it('a daily run freezes the Greek names and shows them when it started in Greek', () => {
    expect(pairs.newState({ locale: 'el', greekVersion: 'el-1' })).toMatchObject({ oe: 'el-1', gr: true });
    expect(pairs.newState({ locale: 'en', greekVersion: 'el-1' })).not.toHaveProperty('gr');
    expect(pairs.alphabetOf(pairs.newState({ locale: 'el', greekVersion: 'el-1' }))).toBe('greek');
    expect(pairs.rebase({ ...pairs.newState({ locale: 'el', greekVersion: 'el-1' }), r: 3 })).toMatchObject({ r: 0, oe: 'el-1', gr: true });
  });

  it('a room match freezes the Greek names and judges Greek text with them', () => {
    const s = startPairs(2, 0, { locales: ['el', 'en'], russianVersion: null, greekVersion: 'el-1' });
    expect(s.oe).toBe('el-1');
    const content = { pack: { release: 'rel-1', pairs: [] }, universe: release, russian: null, greek } as never;
    expect(judgingOf(s, content).pickAmong('νεστωρ', pair.accepted)).toBe('p-nesto');
    expect(judgingOf(s, content, 'greek').player('p-nesto')?.name).toBe('Νέστο Βάλντι');
    expect(() => judgingOf(s, { pack: { release: 'rel-1', pairs: [] }, universe: release } as never)).toThrow(/Greek names are not hydrated/);
  });
});

describe('"that was right" reports in Greek', () => {
  const judging = judgingUniverse(release, null, 'latin', greek);
  const pair = { a: { key: 'club-a' }, b: { key: 'club-b' }, accepted: ['p-orlen'] };

  it('keeps an unknown Greek name as a report and drops a known one', () => {
    expect(refusedName(judging, 'Ζήνων Πέτρου')).toEqual({ release: 'rel-1', subject: null, resolvedPid: null });
    expect(refusedName(judging, 'Νέστωρ')).toBeNull();
  });

  it('a refused Greek name on a pair is read as the footballer it names', () => {
    expect(refusedForPair(judging, pair, 'Νέστωρ')).toEqual({ release: 'rel-1', subject: 'club-a|club-b', resolvedPid: 'p-nesto' });
    expect(refusedForPair(judging, pair, 'Όρλεν')).toBeNull();
  });
});

describe('Greek names: loading and rooms', () => {
  beforeEach(() => {
    forgetGreek();
    db.sql.mockReset();
    db.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('FROM wordgame_el_versions')) return [{ players: 1 }];
      return [{ pid: 'p-nesto', name_el: 'Νέστο Βάλντι', game_name_el: 'Νέστος', aliases_el: ['Νέστωρ'], fame: 60 }];
    });
  });

  it('loads a version with its alternative spellings as aliases', async () => {
    const index = await greekIndex('el-a');
    expect(index.resolve('Νεστωρ')).toEqual(['p-nesto']);
    expect(heldGreekIndex('el-a')).toBe(index);
  });

  it('a daily run under its transaction asks for a missing Greek version to be loaded first, then judges with it', async () => {
    const thrown = await frozenUniverse(release, { oe: 'el-c' }, 'greek', false).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(LoadFirst);
    expect(db.sql).not.toHaveBeenCalled();
    await (thrown as LoadFirst).load();
    const universe = await frozenUniverse(release, { oe: 'el-c' }, 'greek', false);
    expect(universe.resolve('Νέστωρ')).toEqual(['p-nesto']);
    expect(universe.last('p-nesto')).toBe('Σ');
  });

  it('a cold room (release not in memory) under its match lock refuses before loading the release or the names', async () => {
    const releaseLoad = vi.spyOn(footballersService, 'universe');
    const state = startMatch(2, 0, { locales: ['el', 'el'], russianVersion: null, greekVersion: 'el-cold' });
    await expect(roomEngine.hydrate!({ pack: { release: 'rel-1', seed: 1 }, universe: null } as never, state, {} as never)).rejects.toBeInstanceOf(RoomContentUnavailable);
    const pairsState = startPairs(2, 0, { locales: ['el'], russianVersion: null, greekVersion: 'el-cold' });
    await expect(sharedPlayerRoomEngine.hydrate!({ pack: { release: 'rel-1', pairs: [] }, universe: null } as never, pairsState, {} as never))
      .rejects.toBeInstanceOf(RoomContentUnavailable);
    expect(releaseLoad).not.toHaveBeenCalled();
    expect(db.sql).not.toHaveBeenCalled();
    releaseLoad.mockRestore();
  });

  it('a room hydrating under its match lock with a Greek version not in memory refuses, without reading the database', async () => {
    const content = { pack: { release: 'rel-1', seed: 1 }, universe: release };
    const state = { ...startMatch(2, 0, { locales: ['el', 'el'], russianVersion: null, greekVersion: 'el-b' }) };
    await expect(roomEngine.hydrate!(content as never, state, {} as never)).rejects.toBeInstanceOf(RoomContentUnavailable);
    const pairsState = startPairs(2, 0, { locales: ['el', 'el'], russianVersion: null, greekVersion: 'el-b' });
    await expect(sharedPlayerRoomEngine.hydrate!({ pack: { release: 'rel-1', pairs: [] }, universe: release } as never, pairsState, {} as never))
      .rejects.toBeInstanceOf(RoomContentUnavailable);
    expect(db.sql).not.toHaveBeenCalled();
    // Before the lock it loads; under the lock it then reuses what it holds.
    const hydrated = await roomEngine.hydrate!(content as never, state, undefined);
    expect((hydrated as { greek: unknown }).greek).toBeTruthy();
    db.sql.mockClear();
    await expect(roomGreekView(release, null, 'el-b', true)).resolves.toBeTruthy();
    expect(db.sql).not.toHaveBeenCalled();
  });
});
