import { describe, expect, it } from 'vitest';
import { applyCommand, BOT_CLUE_MS, startMatch, tick, viewOf, type CodenamesCommand, type CodenamesState } from '../../src/modules/room/games/codenames/codenames.engine.js';
import { codenamesRoomEngine } from '../../src/modules/room/games/codenames/codenames.room.js';
import {
  clueOnBoard, clueProblem, clueTerm, codenamesPackSchema, codenamesWordItemSchema, dealWordBoard, rng, wordItemId, type CodenamesWordItem, type WordsPack,
} from '../../src/modules/room/games/codenames/codenames.rules.js';
import { dealPractice, practiceClues, prepareDeck } from '../../src/modules/codenames/codenames.words.js';
import type { RoomPoolPick } from '../../src/modules/room/room.engine.js';
import { clientCanPlay, roomEngineFor } from '../../src/modules/room/room.registry.js';
import { CODENAMES_WORDS_TOKEN, declaresRoomOptions, roomOptionsKey } from '../../src/realtime/client-games.js';

// INVENTED words and clues (public repo).
const word = (w: string, clues: string[], lang: CodenamesWordItem['lang'] = 'en'): CodenamesWordItem =>
  codenamesWordItemSchema.parse({ id: wordItemId(lang, w), lang, word: w, football: `${w} on the pitch`, other: `${w} at home`, clues });
const deck = (n: number) => Array.from({ length: n }, (_, i) => word(`WORD${String.fromCharCode(65 + (i % 26))}${i}`, [`Theme${i % 6}`, `Pair${i % 11}`, `Odd${i % 4}`]));

const NOW = 1_000_000;
const ok = (s: CodenamesState, c: WordsPack, seat: number, cmd: CodenamesCommand) => {
  const r = applyCommand(s, c, seat, cmd, NOW);
  expect(r.error).toBeUndefined();
  return r.state;
};

describe('codenames word boards', () => {
  it('deals 25 words keyed 9 / 8 / 7 / 1 with the clues as terms', () => {
    const pack = dealWordBoard(deck(25), 'en', rng(3), 5);
    expect(codenamesPackSchema.safeParse(pack).success).toBe(true);
    const own = pack.starting === 0 ? 't0' : 't1';
    const count = (k: string) => pack.cards.filter((c) => c.key === k).length;
    expect([count(own), count(own === 't0' ? 't1' : 't0'), count('neutral'), count('owngoal')]).toEqual([9, 8, 7, 1]);
    expect(pack.cards[0].terms.every((t) => t.label.en === t.label.ka)).toBe(true);
    // The same clue on two cards is one term, in any script.
    expect(clueTerm('Kitchen').id).toBe(clueTerm(' kitchen ').id);
    expect(clueTerm('Кухня').id).toMatch(/^c-[a-z0-9]+$/);
    expect(clueTerm('სახლი').id).not.toBe(clueTerm('Кухня').id);
  });

  it('keeps old picture packs valid and refuses a word pack with a wrong split', () => {
    const pack = dealWordBoard(deck(25), 'en', rng(4), 5);
    const broken = { ...pack, cards: pack.cards.map((c) => (c.key === 'neutral' ? { ...c, key: 'owngoal' as const } : c)) };
    expect(codenamesPackSchema.safeParse(broken).success).toBe(false);
    expect(codenamesPackSchema.safeParse({ ...pack, kind: 'pictures' }).success).toBe(false);
  });

  it('refuses a clue that is a hidden word, part of one or contains one', () => {
    const board = ['STONES', 'BAR', 'CROSS', 'PIQUÉ'];
    expect(clueOnBoard('stones', board)).toBe('STONES');
    expect(clueOnBoard('Stone', board)).toBe('STONES');
    expect(clueOnBoard('Crossbar', board)).toBe('BAR');
    expect(clueOnBoard('Pique', board)).toBe('PIQUÉ');
    expect(clueOnBoard('Red Cross', board)).toBe('CROSS');
    expect(clueOnBoard('Arsenal', board)).toBeNull();
    expect(clueOnBoard('Ba', board)).toBeNull();
    expect(clueProblem('Stone', new Set(), board)).toBe('board');
    expect(clueProblem('Stone', new Set())).toBeNull();
  });

  it('plays a 25-card match: board words refused, a revealed word allowed, index past the board refused', () => {
    const c = dealWordBoard(deck(25), 'en', rng(9), 5);
    let s = startMatch(4, c, NOW, 0);
    expect(s.revealed).toHaveLength(25);
    s = ok(s, c, 0, { type: 'join', team: c.starting, scout: true });
    s = ok(s, c, 1, { type: 'join', team: c.starting, scout: false });
    s = ok(s, c, 2, { type: 'join', team: c.starting === 0 ? 1 : 0, scout: true });
    s = ok(s, c, 3, { type: 'join', team: c.starting === 0 ? 1 : 0, scout: false });
    s = ok(s, c, 0, { type: 'kickoff' });
    const target = c.cards[0].word;
    expect(applyCommand(s, c, 0, { type: 'clue', turn: 0, word: target.toLowerCase(), count: 1 }, NOW).error).toBe('board');
    s = ok(s, c, 0, { type: 'clue', turn: 0, word: 'Elsewhere', count: 2 });
    expect(applyCommand(s, c, 1, { type: 'flip', turn: 0, card: 24 }, NOW).error).toBeUndefined();
    const view = viewOf(s, c, 1, 'en') as { board?: string; lang?: string; cards: Array<{ word?: string; key: unknown }> };
    expect(view.board).toBe('words');
    expect(view.lang).toBe('en');
    expect(view.cards).toHaveLength(25);
    expect(view.cards.every((card) => typeof card.word === 'string' && card.key === null)).toBe(true);
  });

  it('lets the bot Scout clue a word board from the deck clues', () => {
    const c = dealWordBoard(deck(25), 'en', rng(11), 5);
    let s = startMatch(2, c, NOW, 0);
    s = ok(s, c, 0, { type: 'join', team: 0, scout: false });
    s = ok(s, c, 1, { type: 'join', team: 1, scout: false });
    s = ok(s, c, 0, { type: 'kickoff' });
    s = tick(s, c, NOW + BOT_CLUE_MS);
    expect(s.phase).toBe('guess');
    expect(s.clue?.bot).toBe(true);
    expect(c.cards.some((card) => card.terms.some((t) => t.id === s.clue?.term?.id))).toBe(true);
  });

  it('a picture room keeps no options; a words room needs a language and deals from its tag', async () => {
    expect(codenamesRoomEngine.parseOptions(null)).toBeNull();
    expect(codenamesRoomEngine.parseOptions({ board: 'words', lang: 'ka' })).toEqual({ board: 'words', lang: 'ka' });
    expect(codenamesRoomEngine.parseOptions({ board: 'words' })).toBeUndefined();
    expect(codenamesRoomEngine.parseOptions({ board: 'pictures', lang: 'en' })).toBeUndefined();
    const tags: Array<string | undefined> = [];
    const words = deck(25).map((w) => ({ ...w, lang: 'es' as const, id: wordItemId('es', w.word) }));
    const pick: RoomPoolPick = async (wanted, tag) => {
      tags.push(tag);
      return words.slice(0, wanted.easy).map((payload) => ({ item_id: payload.id, difficulty: 'easy', payload }));
    };
    const dealt = await codenamesRoomEngine.deal(pick, { board: 'words', lang: 'es' }, 4);
    expect(tags).toEqual(['word-es']);
    expect((dealt?.content as WordsPack).kind).toBe('words');
    expect(dealt?.itemIds).toHaveLength(25);
    // A short deck (or another language's words) is no board.
    const short: RoomPoolPick = async () => words.slice(0, 24).map((payload) => ({ item_id: payload.id, difficulty: 'easy', payload }));
    expect(await codenamesRoomEngine.deal(short, { board: 'words', lang: 'es' }, 4)).toBeNull();
    expect(await codenamesRoomEngine.deal(pick, { board: 'words', lang: 'en' }, 4)).toBeNull();
  });
});

describe('codenames word practice', () => {
  it('fixes up to 4 clues that cover only the player\'s words and never the Own Goal', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const board = dealPractice(deck(80), 'en', rng(seed))!;
      expect(board.cards).toHaveLength(25);
      expect(board.cards.filter((c) => c.kind === 'mine')).toHaveLength(9);
      expect(board.clues.length).toBeGreaterThan(0);
      expect(board.clues.length).toBeLessThanOrEqual(4);
      const kind = new Map(board.cards.map((c) => [c.id, c.kind]));
      const meant = board.clues.flatMap((c) => c.cards.map((m) => m.id));
      expect(new Set(meant).size).toBe(meant.length);
      expect(meant.every((id) => kind.get(id) === 'mine')).toBe(true);
      expect(board.clues.every((c) => c.count === c.cards.length && c.cards.every((m) => m.why.includes(' · ')))).toBe(true);
    }
  });

  it('never picks a clue the Own Goal fits', () => {
    const [alpha, beta, omega] = prepareDeck([word('ALPHA', ['Shared', 'Solo']), word('BETA', ['Shared']), word('OMEGA', ['Shared'])]);
    const cards = [{ ...alpha, key: 't0' as const }, { ...beta, key: 't0' as const }, { ...omega, key: 'owngoal' as const }];
    expect(practiceClues(cards).map((c) => c.word)).toEqual(['Solo']);
  });

  it('has no board for a deck under 25 words', () => {
    expect(dealPractice(deck(24), 'en', rng(1))).toBeNull();
  });
});

describe('codenames word boards across versions', () => {
  it('stores word matches as version 2 and picture matches as version 1, both run by this build', () => {
    expect(codenamesRoomEngine.versionFor?.({ board: 'words', lang: 'en' })).toBe(2);
    expect(codenamesRoomEngine.versionFor?.(null)).toBe(1);
    expect(roomEngineFor('codenames', 1)).toBe(roomEngineFor('codenames', 2));
    expect(roomEngineFor('codenames', 3)).toBeNull();
  });

  it('admits to a word match only a screen that lists codenames@2', () => {
    expect(clientCanPlay('codenames', ['codenames'], 1)).toBe(true);
    expect(clientCanPlay('codenames', ['codenames'], 2)).toBe(false);
    expect(clientCanPlay('codenames', ['codenames', CODENAMES_WORDS_TOKEN], 2)).toBe(true);
    expect(clientCanPlay('codenames', [CODENAMES_WORDS_TOKEN], 2)).toBe(false);
  });

  it('asks the lobby for codenames@2 only on a word board', () => {
    const words = { room_game: 'codenames', room_options: { board: 'words', lang: 'en' } };
    expect(declaresRoomOptions({ games: ['codenames'] }, words)).toBe(false);
    expect(declaresRoomOptions({ games: ['codenames', CODENAMES_WORDS_TOKEN] }, words)).toBe(true);
    expect(declaresRoomOptions({ games: ['codenames'] }, { room_game: 'codenames', room_options: null })).toBe(true);
  });

  it('keys room options the same whatever the key order', () => {
    expect(roomOptionsKey({ lang: 'en', board: 'words' })).toBe(roomOptionsKey({ board: 'words', lang: 'en' }));
    expect(roomOptionsKey(null)).toBeNull();
    expect(roomOptionsKey({ board: 'words', lang: 'en' })).toBe('{"board":"words","lang":"en"}');
  });

  it('drops a clue from a dealt card when it overlaps another word on the same board', () => {
    const items = deck(25);
    items[0] = word('ALPHA', ['Betamax', 'Theme0']);
    items[1] = word('BETA', ['Theme1', 'Pair1']);
    const pack = dealWordBoard(items, 'en', rng(2), 1);
    const alpha = pack.cards.find((c) => c.word === 'ALPHA')!;
    expect(alpha.terms.map((t) => t.label.en)).toEqual(['Theme0']);
  });
});
