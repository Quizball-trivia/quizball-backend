import { describe, expect, it } from 'vitest';
import { CD_CLUE_COSTS, freeCluesFor, matchesCardName } from '../../../../src/modules/partners/games/card-detective/cd-partner.rules.js';

/** The web's freeCluesFor (frontend DetectiveCard.tsx), copied verbatim: the server must open the same slots. */
function webFreeCluesFor(cardId: string): string[] {
  const STAT_CLUES = ['pac', 'sho', 'pas', 'dri', 'def', 'phy'];
  let h = 7;
  for (const ch of cardId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const first = h % STAT_CLUES.length;
  const second = (first + 1 + ((h >>> 8) % (STAT_CLUES.length - 1))) % STAT_CLUES.length;
  return ['position', STAT_CLUES[first], STAT_CLUES[second]];
}

describe('Card Detective partner rules', () => {
  it('prices match contract v1.2 §7.3', () => {
    expect(CD_CLUE_COSTS).toEqual({ rating: 25, club: 20, league: 15, nation: 10, position: 10, pac: 5, sho: 5, pas: 5, dri: 5, def: 5, phy: 5 });
  });

  it('opens the position and two different stats, the same ones as the web', () => {
    for (const ref of ['a1b2c3d4e5f60718', '0000000000000000', 'ffffffffffffffff', '9c1e57aa03b2d4e6']) {
      const free = freeCluesFor(ref);
      expect(free).toEqual(webFreeCluesFor(ref));
      expect(free[0]).toBe('position');
      expect(free[1]).not.toBe(free[2]);
    }
  });

  it('accepts a full name, a surname and small typos; folds accents and Georgian script', () => {
    const accepted = ['Testo Müllerovic', 'Müllerovic'];
    expect(matchesCardName('Testo Müllerovic', accepted)).toBe(true);
    expect(matchesCardName('mullerovic', accepted)).toBe(true);
    expect(matchesCardName('Mulerovic', accepted)).toBe(true);
    expect(matchesCardName('Testo Mullerovich', accepted)).toBe(true);
    expect(matchesCardName('მესი', ['Messi'])).toBe(true);
  });

  it('matches a Cyrillic guess only against the Russian aliases', () => {
    const kane = ['Harry Kane', 'H. Kane', 'Kane', 'Гарри Кейн', 'Кейн'];
    expect(matchesCardName('Кейн', kane)).toBe(true);
    expect(matchesCardName('гарри кейн', kane)).toBe(true);
    expect(matchesCardName('Кеин', kane)).toBe(true);
    expect(matchesCardName('Мане', kane)).toBe(false);
    expect(matchesCardName('Kane', kane)).toBe(true);
    expect(matchesCardName('Mane', kane)).toBe(true);
    expect(matchesCardName('Месси', ['Lionel Messi', 'Messi'])).toBe(false);
    expect(matchesCardName('Холанд', ['Erling Haaland', 'Эрлинг Холанд', 'Холанд', 'Холанн'])).toBe(true);
    expect(matchesCardName('Холан', ['Erling Haaland', 'Эрлинг Холанд', 'Холанд', 'Холанн'])).toBe(true);
    expect(matchesCardName('ван', ['Virgil van Dijk', 'Вирджил ван Дейк', 'ван Дейк'])).toBe(false);
    expect(matchesCardName('Дейк', ['Virgil van Dijk', 'Вирджил ван Дейк', 'ван Дейк'])).toBe(true);
    expect(matchesCardName('ᲙᲔᲘᲜᲘ', ['Harry Kane', 'ჰარი კეინი'])).toBe(true);
  });

  it('refuses fragments, particles and short near-misses', () => {
    expect(matchesCardName('rovic', ['Testo Müllerovic'])).toBe(false);
    expect(matchesCardName('de', ['Frenk de Jongsma'])).toBe(false);
    expect(matchesCardName('van', ['Virgo van Dijksma'])).toBe(false);
    expect(matchesCardName('Kim', ['Min-jae Kom'])).toBe(false);
    expect(matchesCardName('Kom', ['Min-jae Kom'])).toBe(true);
    expect(matchesCardName('', ['Anyone'])).toBe(false);
    expect(matchesCardName('Someone Else', ['Testo Müllerovic'])).toBe(false);
  });
});
