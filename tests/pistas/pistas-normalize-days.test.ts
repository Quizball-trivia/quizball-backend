import { describe, expect, it } from 'vitest';
import { containsWords, isAcceptedGuess, normalizeAnswer, samePlayer } from '../../src/modules/pistas/pistas.normalize.js';
import {
  addDays, boardDay, CONTENT_START, dayEndsAt, dayNumber, isClosedDay, isPlayableDay, LAST_DAY, PUBLISHED_DAYS, RANKED_START, rankedDay, releaseDay,
} from '../../src/modules/pistas/pistas.days.js';

describe('pistas answer normalisation', () => {
  it('ignores case, accents, punctuation and spacing; keeps digits and non-Latin letters', () => {
    for (const v of ['Dé Lorén', 'de loren', 'DE-LORÉN', '  de   lorén ', 'Dé.Lorén!', 'de_loren']) expect(normalizeAnswer(v)).toBe('de loren');
    expect(normalizeAnswer("N'Tolo Varné")).toBe('n tolo varne');
    expect(normalizeAnswer('Çetinoğlu')).toBe('cetinoglu');
    expect(normalizeAnswer('İnan Gürdoğ')).toBe('inan gurdog');
    expect(normalizeAnswer('ტესტი სახელი')).toBe('ტესტი სახელი');
    expect(normalizeAnswer('Número 7')).toBe('numero 7');
    expect(normalizeAnswer('!!! ?')).toBe('');
  });

  it('folds the Latin letters NFD leaves whole the way players type them', () => {
    expect(normalizeAnswer('Østvik')).toBe('ostvik');
    expect(normalizeAnswer('Yılmazer')).toBe('yilmazer');
    expect(normalizeAnswer('Władek')).toBe('wladek');
    expect(normalizeAnswer('Straße')).toBe('strasse');
  });

  it('a guess matches regardless of spaces and punctuation, never of letters', () => {
    const accepted = ['lora', 'juan lora', 'n dala marti', 'van der oort'];
    for (const guess of ['L.O.R.A', '  lora  ', 'NDala Martí', "N'Dala  Marti", 'VanDerOort', 'van-der-oort']) {
      expect(isAcceptedGuess(accepted, normalizeAnswer(guess)), guess).toBe(true);
    }
    for (const guess of ['lor', 'loraa', 'juan', '...', '']) expect(isAcceptedGuess(accepted, normalizeAnswer(guess)), guess).toBe(false);
  });

  it("samePlayer: a display name matching the other side's display or alias is the same player; a shared surname is not", () => {
    const longName = { display: ['Juan Carlos Pérez Gómez'], accepted: ['Juanca', 'Juan Carlos Pérez Gómez'] };
    expect(samePlayer({ display: ['Juanca'], accepted: ['Juanca'] }, longName)).toBe(true);
    expect(samePlayer(longName, { display: ['Juanca'], accepted: [] })).toBe(true);
    expect(samePlayer({ display: ['Ana Sánchez'], accepted: ['Sánchez', 'Ana'] }, { display: ['Bea Sánchez'], accepted: ['Sánchez', 'Bea'] })).toBe(false);
  });

  it('has no typo tolerance', () => {
    expect(normalizeAnswer('Pereyra')).not.toBe(normalizeAnswer('Pereira'));
    expect(normalizeAnswer('Varela')).not.toBe(normalizeAnswer('Varelita'));
  });

  it('matches whole words only', () => {
    expect(containsWords('jugo con de loren en el sur', 'de loren')).toBe(true);
    expect(containsWords('de loren', 'de loren')).toBe(true);
    expect(containsWords('jugo con varelita', 'varela')).toBe(false);
    expect(containsWords('anything', '')).toBe(false);
  });
});

describe('pistas release calendar', () => {
  it('runs CONTENT_START … LAST_DAY, ranked from RANKED_START', () => {
    expect([CONTENT_START, RANKED_START, PUBLISHED_DAYS, LAST_DAY]).toEqual(['2026-09-27', '2026-09-29', 30, '2026-10-26']);
    expect(dayNumber(CONTENT_START)).toBe(1);
    expect(dayNumber(LAST_DAY)).toBe(30);
  });

  it('a day is playable from its own Buenos Aires midnight: never a future or preview day', () => {
    const sep28 = new Date('2026-09-28T15:00:00Z');
    expect(isPlayableDay('2026-09-27', sep28)).toBe(true);
    expect(isPlayableDay('2026-09-28', sep28)).toBe(true);
    expect(isPlayableDay('2026-09-29', sep28)).toBe(false);
    expect(isPlayableDay('2026-09-26', sep28)).toBe(false);
    // Before the first content day nothing is playable, not even the first day.
    expect(isPlayableDay(CONTENT_START, new Date('2026-09-26T15:00:00Z'))).toBe(false);
    expect(isPlayableDay('2026-09-29', new Date('2026-09-29T02:59:59Z'))).toBe(false);
    expect(isPlayableDay('2026-09-29', new Date('2026-09-29T03:00:00Z'))).toBe(true);
    // After the last day, the last day stays playable and nothing later is.
    const after = new Date('2026-11-10T15:00:00Z');
    expect(isPlayableDay(LAST_DAY, after)).toBe(true);
    expect(isPlayableDay(addDays(LAST_DAY, 1), after)).toBe(false);
  });

  it('ranks today only between RANKED_START and LAST_DAY', () => {
    expect(rankedDay(new Date('2026-09-28T15:00:00Z'))).toBeNull();
    expect(rankedDay(new Date('2026-09-29T15:00:00Z'))).toBe('2026-09-29');
    expect(rankedDay(new Date('2026-10-26T15:00:00Z'))).toBe('2026-10-26');
    expect(rankedDay(new Date('2026-10-27T15:00:00Z'))).toBeNull();
    expect(boardDay(new Date('2026-09-28T15:00:00Z'))).toBe(RANKED_START);
    expect(boardDay(new Date('2026-09-30T15:00:00Z'))).toBe('2026-09-30');
    expect(boardDay(new Date('2026-11-05T15:00:00Z'))).toBe(LAST_DAY);
  });

  it('a day closes at the next Buenos Aires midnight, where releaseDay rolls over', () => {
    expect(isClosedDay('2026-09-28', new Date('2026-09-29T02:59:59Z'))).toBe(false);
    expect(isClosedDay('2026-09-28', new Date('2026-09-29T03:00:00Z'))).toBe(true);
    expect(dayEndsAt('2026-09-28').toISOString()).toBe('2026-09-29T03:00:00.000Z');
    for (let i = 0; i < PUBLISHED_DAYS; i += 1) {
      const day = addDays(CONTENT_START, i);
      const end = dayEndsAt(day).getTime();
      expect(releaseDay(new Date(end - 1))).toBe(day);
      expect(releaseDay(new Date(end))).toBe(addDays(day, 1));
    }
  });
});
