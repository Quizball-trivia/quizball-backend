import { describe, expect, it } from 'vitest';
import { isClueBlocked } from '../../src/modules/room/games/codenames/codenames.moderation.js';
import { clueProblem, codenamesWordItemSchema, termLabelSchema, wordItemId } from '../../src/modules/room/games/codenames/codenames.rules.js';
import { ROOM_LOCALES } from '../../src/modules/room/room.types.js';

describe('Codenames clue moderation in French, Portuguese and German', () => {
  it.each(['Putain', 'PUTE', 'enculé', 'Enculés', 'ta gueule', "d'enculé", 'caralho', 'CARALHOS', 'foda-se', 'no cu', 'scheiße', 'Scheisse', 'hurensohn', 'Wichser'])('refuses %s', (clue) => {
    expect(isClueBlocked(clue)).toBe(true);
    expect(clueProblem(clue, new Set())).toBe('blocked');
  });

  it('folds œ and ß, typed or not', () => {
    expect(isClueBlocked('SCHEISS')).toBe(true);
    expect(isClueBlocked('scheiß')).toBe(true);
    expect(isClueBlocked('cœur')).toBe(false);
    expect(isClueBlocked('coeur')).toBe(false);
  });

  // Ordinary words of one language, or real football names, that look like a word of another.
  it.each(['con', 'bite', 'but', 'negro', 'Foden', 'Foda', 'Fodé', 'Porro', 'porra', 'pede', 'Arschawin', 'Nuttall', 'raton', 'culé', 'Viadana', 'Connor', 'gardien'])('lets %s through', (clue) => {
    expect(isClueBlocked(clue)).toBe(false);
  });

  it('keeps the older languages blocked', () => {
    for (const clue of ['fuck', 'mierda', 'orospu', 'сука', 'ტრაკი']) expect(isClueBlocked(clue)).toBe(true);
  });
});

describe('a French Codenames word', () => {
  // Invented wording only: the deck itself is private.
  const item = { id: wordItemId('fr', 'INVENTION'), lang: 'fr', word: 'INVENTION', football: 'Un sens inventé', other: 'Un autre sens', clues: ['Indice inventé'] };

  it('is a room locale and a term label', () => {
    expect(ROOM_LOCALES).toContain('fr');
    expect(termLabelSchema.safeParse({ en: 'x', es: 'x', tr: 'x', ru: 'x', ka: 'x', fr: 'x' }).success).toBe(true);
    expect(codenamesWordItemSchema.safeParse(item).success).toBe(true);
  });
});
