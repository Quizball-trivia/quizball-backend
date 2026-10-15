import { describe, expect, it } from 'vitest';
import { judgingUniverse, russianView } from '../../src/modules/footballers/footballers.russian.js';
import { buildRussianIndex, buildUniverse, type UniversePlayer } from '../../src/modules/footballers/footballers.universe.js';
import { startMatch } from '../../src/modules/room/games/name-chain/name-chain.engine.js';
import { newState, rebase } from '../../src/modules/name-chain-daily/name-chain-daily.rules.js';

// Invented footballers only: the repository is public.
const P = (pid: string, name: string, game: string, fame: number): UniversePlayer => ({ pid, name, game, fame, aliases: [] });
const release = buildUniverse('rel-1', [P('p-orlen', 'Tarin Orlen', 'Orlen', 80), P('p-nesto', 'Nesto', 'Nesto', 40), P('p-kosel', 'Emir Kosel', 'Kosel', 60)]);
const names = buildRussianIndex('ru-1', [
  P('p-orlen', 'Тарин Орлен', 'Орлен', 80), P('p-nesto', 'Несто', 'Несто', 40), P('p-elsewhere', 'Олег Тихий', 'Тихий', 90),
]);
const russian = russianView(release, names);

describe('judging with Russian names', () => {
  it('reads Cyrillic text with the Russian names of the release only, and Latin text exactly as before', () => {
    const latinLetters = judgingUniverse(release, russian, 'latin');
    expect(latinLetters.resolve('орлен')).toEqual(['p-orlen']);
    expect(latinLetters.resolve('Orlen')).toEqual(release.resolve('Orlen'));
    expect(latinLetters.resolve('тихий')).toEqual([]);
    expect(latinLetters.last('p-orlen')).toBe(release.last('p-orlen'));
    expect(latinLetters.player('p-orlen')?.name).toBe('Tarin Orlen');
  });

  it('plays Russian letters and shows Russian names on the Cyrillic alphabet', () => {
    const cyrillic = judgingUniverse(release, russian, 'cyrillic');
    expect(cyrillic.last('p-orlen')).toBe('Н');
    expect(cyrillic.player('p-orlen')?.name).toBe('Тарин Орлен');
    // A footballer without a Russian name keeps his Latin name and has no Russian letter.
    expect(cyrillic.player('p-kosel')?.name).toBe('Emir Kosel');
    expect(cyrillic.starts('p-kosel')).toEqual([]);
    expect(cyrillic.alphabet[0]).toBe('А');
    // A Latin answer still names the footballer; his Russian letters decide whether it fits.
    expect(cyrillic.resolve('Orlen')).toEqual(['p-orlen']);
  });

  it('is the release itself when no Russian names were frozen', () => {
    expect(judgingUniverse(release, null, 'cyrillic')).toBe(release);
  });
});

describe('what a run or match freezes', () => {
  it('a daily run freezes the names on, and Russian letters only when it started in Russian', () => {
    expect(newState({ locale: 'ru', russianVersion: 'ru-1' })).toMatchObject({ ov: 'ru-1', al: 'cy' });
    expect(newState({ locale: 'en', russianVersion: 'ru-1' })).toMatchObject({ ov: 'ru-1' });
    expect(newState({ locale: 'en', russianVersion: 'ru-1' }).al).toBeUndefined();
    expect(newState({ locale: 'ru', russianVersion: null })).not.toHaveProperty('al');
    expect(rebase({ ...newState({ locale: 'ru', russianVersion: 'ru-1' }), c: 2 })).toMatchObject({ c: 0, ov: 'ru-1', al: 'cy' });
  });

  it('a room plays Russian letters only when every admitted player plays in Russian', () => {
    expect(startMatch(2, 0, { locales: ['ru', 'ru'], russianVersion: 'ru-1' })).toMatchObject({ ov: 'ru-1', al: 'cy' });
    expect(startMatch(2, 0, { locales: ['ru', 'en'], russianVersion: 'ru-1' }).al).toBeUndefined();
    expect(startMatch(2, 0, { locales: ['ru', 'ru'], russianVersion: null })).not.toHaveProperty('ov');
    expect(startMatch(2, 0)).not.toHaveProperty('al');
  });
});
