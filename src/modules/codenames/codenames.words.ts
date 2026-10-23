import { randomInt } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { sql } from '../../db/index.js';
import { ROOM_LOCALES, type RoomLocale } from '../room/room.types.js';
import {
  botTerms, codenamesWordItemSchema, fold, sayable, shuffled, WORDS_BOARD, wordTag, type CardKey, type CodenamesWordItem,
} from '../room/games/codenames/codenames.rules.js';

/**
 * Solo word boards: unranked practice, a new board every time. The server deals 25 words of the player's language and
 * fixes the bot Scout's clues up front; the run is played and judged on the device (no score is kept, so the board
 * goes out with its key). The clues cover all of the player's 9 words whenever a deal allows it.
 */
export const PRACTICE_CLUES = 4;
const DECK_TTL_MS = 10 * 60_000;
const MAX_DEALS = 40;

export const practiceQuerySchema = z.object({ lang: z.enum(ROOM_LOCALES) }).strict();

type Kind = 'mine' | 'theirs' | 'neutral' | 'owngoal';
export interface PracticeBoard {
  lang: RoomLocale;
  /** Every card with both its meanings (the result page explains the whole board). */
  cards: Array<{ id: string; word: string; kind: Kind; football: string; other: string }>;
  clues: Array<{ word: string; count: number; cards: Array<{ id: string; why: string }> }>;
}

const KIND: Record<CardKey, Kind> = { t0: 'mine', t1: 'theirs', neutral: 'neutral', owngoal: 'owngoal' };

/** A deck word ready to deal: its clues' term ids worked out once per deck, not once per board. */
export interface PreparedWord extends CodenamesWordItem { clueIds: Array<{ id: string; clue: string }> }

const prepared = new WeakMap<readonly CodenamesWordItem[], PreparedWord[]>();

/**
 * The deck with each word's clues as term ids, minus any clue that is, holds or is part of a deck word (the seed
 * refuses those; this keeps a hand-edited row from ever reaching a player).
 */
export function prepareDeck(deck: readonly CodenamesWordItem[]): PreparedWord[] {
  const cached = prepared.get(deck);
  if (cached) return cached;
  // One card per spelling: two rows that fold to the same word (a hand edit) would put twins on one board.
  const seen = new Set<string>();
  const unique = deck.filter((w) => !seen.has(fold(w.word)) && Boolean(seen.add(fold(w.word))));
  const legal = sayable(unique.map((w) => w.word));
  const ready = unique.map((w) => ({ ...w, clueIds: botTerms(w.clues, legal).map((t) => ({ id: t.id, clue: t.label.en })) }));
  prepared.set(deck, ready);
  return ready;
}

/** Each clue the one covering most still-unclued words of the player's (never one that touches the Own Goal). */
export function practiceClues(cards: ReadonlyArray<PreparedWord & { key: CardKey }>, max = PRACTICE_CLUES): PracticeBoard['clues'] {
  const left = new Set(cards.filter((c) => c.key === 't0').map((c) => c.id));
  const why = new Map(cards.map((c) => [c.id, `${c.football} · ${c.other}`]));
  const said = new Set<string>();
  const clues: PracticeBoard['clues'] = [];
  while (left.size > 0 && clues.length < max) {
    const score = new Map<string, { word: string; ids: string[]; bad: number }>();
    for (const card of cards) {
      if (card.key === 't0' && !left.has(card.id)) continue;
      for (const { id, clue } of card.clueIds) {
        if (said.has(id)) continue;
        const e = score.get(id) ?? { word: clue, ids: [], bad: 0 };
        if (card.key === 't0') e.ids.push(card.id);
        else e.bad += card.key === 'owngoal' ? 100 : card.key === 't1' ? 2 : 1;
        score.set(id, e);
      }
    }
    const value = (e: { ids: string[]; bad: number }) => e.ids.length * 2 - e.bad;
    let best: [string, { word: string; ids: string[]; bad: number }] | null = null;
    for (const entry of score) {
      const [id, e] = entry;
      if (e.ids.length === 0 || e.bad >= 100) continue;
      if (!best || value(e) > value(best[1]) || (value(e) === value(best[1]) && (e.ids.length > best[1].ids.length || (e.ids.length === best[1].ids.length && id < best[0])))) best = entry;
    }
    if (!best) break;
    const [id, e] = best;
    said.add(id);
    e.ids.forEach((cardId) => left.delete(cardId));
    clues.push({ word: e.word, count: e.ids.length, cards: e.ids.map((cardId) => ({ id: cardId, why: why.get(cardId)! })) });
  }
  return clues;
}

/**
 * A board from a deck, built around clues: the player's 9 words are drawn as groups that share a clue (3 + 2 + 2 + 2),
 * the other 16 at random, then the clues are chosen on the finished board. Tried again (up to MAX_DEALS) until the
 * clues cover all 9 (an Own Goal or rival word on a group's clue can block it); null when no deal does.
 */
export function dealPractice(deck: readonly CodenamesWordItem[], lang: RoomLocale, random: () => number): PracticeBoard | null {
  const { words, groups } = groupsOf(deck);
  if (words.length < WORDS_BOARD.size) return null;
  let best: { cards: Array<PreparedWord & { key: CardKey }>; clues: PracticeBoard['clues']; covered: number } | null = null;
  for (let deal = 0; deal < MAX_DEALS && (!best || best.covered < WORDS_BOARD.starting); deal += 1) {
    const mine = pickGroups(groups, random) ?? pickWords(words, WORDS_BOARD.starting, random);
    const taken = new Set(mine);
    const rest = pickWords(words.filter((w) => !taken.has(w)), WORDS_BOARD.size - WORDS_BOARD.starting, random);
    const restKeys = shuffled<CardKey>([
      ...Array<CardKey>(WORDS_BOARD.other).fill('t1'), ...Array<CardKey>(WORDS_BOARD.neutral).fill('neutral'), 'owngoal',
    ], random);
    const cards = shuffled([...mine.map((w) => ({ ...w, key: 't0' as CardKey })), ...rest.map((w, i) => ({ ...w, key: restKeys[i] }))], random);
    const clues = practiceClues(cards);
    const covered = clues.reduce((n, c) => n + c.count, 0);
    if (!best || covered > best.covered) best = { cards, clues, covered };
  }
  // Every board must be winnable: a deck that cannot cover all 9 words in the clues (a broken or thin deck) deals no
  // board rather than one whose best run falls short.
  if (!best || best.covered < WORDS_BOARD.starting) return null;
  const { cards, clues } = best;
  return { lang, cards: cards.map((c) => ({ id: c.id, word: c.word, kind: KIND[c.key], football: c.football, other: c.other })), clues };
}

const grouped = new WeakMap<readonly CodenamesWordItem[], { words: PreparedWord[]; groups: PreparedWord[][] }>();

/** The deck's clues that fit two or more words, each with its words (worked out once per deck). */
function groupsOf(deck: readonly CodenamesWordItem[]): { words: PreparedWord[]; groups: PreparedWord[][] } {
  const cached = grouped.get(deck);
  if (cached) return cached;
  const words = prepareDeck(deck);
  const byClue = new Map<string, PreparedWord[]>();
  for (const w of words) for (const { id } of w.clueIds) byClue.set(id, [...(byClue.get(id) ?? []), w]);
  const result = { words, groups: [...byClue.values()].filter((g) => g.length >= 2) };
  grouped.set(deck, result);
  return result;
}

/** 9 distinct words in groups of 3, 2, 2 and 2, each group sharing one clue; null when the draws keep colliding. */
function pickGroups(groups: PreparedWord[][], random: () => number): PreparedWord[] | null {
  if (groups.length === 0) return null;
  const chosen: PreparedWord[] = [];
  for (const size of [3, 2, 2, 2]) {
    let placed = false;
    for (let attempt = 0; attempt < 12 && !placed; attempt += 1) {
      const free = groups[Math.floor(random() * groups.length)].filter((w) => !chosen.includes(w));
      if (free.length < size) continue;
      chosen.push(...pickWords(free, size, random));
      placed = true;
    }
    if (!placed) return null;
  }
  return chosen;
}

/** `n` distinct items, a partial Fisher–Yates (no copy of the whole deck shuffled per deal). */
function pickWords<T>(items: readonly T[], n: number, random: () => number): T[] {
  const index = items.map((_, i) => i);
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(random() * (index.length - i));
    [index[i], index[j]] = [index[j], index[i]];
  }
  return index.slice(0, n).map((i) => items[i]);
}

const decks = new Map<RoomLocale, { at: number; words: CodenamesWordItem[] }>();

/** The enabled words of a language (cached per process for a few minutes: the deck changes only by a seed). */
async function deckOf(lang: RoomLocale): Promise<CodenamesWordItem[]> {
  const cached = decks.get(lang);
  if (cached && Date.now() - cached.at < DECK_TTL_MS) return cached.words;
  const rows = await sql<Array<{ payload: unknown }>>`
    SELECT payload FROM room_pool WHERE game = 'codenames' AND enabled AND tags @> ARRAY[${wordTag(lang)}]::text[]
  `;
  const words = rows.flatMap((r) => {
    const word = codenamesWordItemSchema.safeParse(r.payload);
    return word.success && word.data.lang === lang ? [word.data] : [];
  });
  decks.set(lang, { at: Date.now(), words });
  return words;
}

const random = () => randomInt(0, 0x100000000) / 0x100000000;

export const codenamesWordsController = {
  async practice(req: Request, res: Response): Promise<void> {
    const { lang } = req.validated.query as z.infer<typeof practiceQuerySchema>;
    // A language without its own deck yet (pt) practises on the English words rather than finding no board.
    const board = dealPractice(await deckOf(lang), lang, random) ?? (lang === 'en' ? null : dealPractice(await deckOf('en'), 'en', random));
    res.setHeader('Cache-Control', 'no-store');
    if (!board) {
      res.status(503).json({ code: 'CODENAMES_WORDS_UNAVAILABLE', message: 'No word deck for this language yet', details: null, request_id: null });
      return;
    }
    res.json(board);
  },
};
