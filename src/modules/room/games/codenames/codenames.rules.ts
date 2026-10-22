import { z } from 'zod';
import { isClueBlocked } from './codenames.moderation.js';
import { ROOM_LOCALES, type RoomLocale } from '../../room.types.js';

export type Team = 0 | 1;
export type CardKey = 't0' | 't1' | 'neutral' | 'owngoal';

export const BOARD_SIZE = 20;
export const STARTING_TEAM_CARDS = 8;
export const OTHER_TEAM_CARDS = 7;
export const NEUTRAL_CARDS = 4;
/** Caricatures per board: more than this and a board reads as a face quiz. */
export const BOARD_FACES = 6;
export const MAX_CLUE_CHARS = 30;
export const MAX_CLUE_WORDS = 4;
export const MAX_CLUE_COUNT = 9;

/** Word boards, like the original game: 25 words keyed 9 / 8 / 7 / 1. */
export const WORDS_BOARD = { size: 25, starting: 9, other: 8, neutral: 7 } as const;
const PICTURES_BOARD = { size: BOARD_SIZE, starting: STARTING_TEAM_CARDS, other: OTHER_TEAM_CARDS, neutral: NEUTRAL_CARDS } as const;
/** The largest board of any kind (card indexes in commands). */
export const MAX_BOARD_SIZE = WORDS_BOARD.size;
export const MAX_WORD_CHARS = 16;

// A name the bot says must fit the clue limit a Scout has.
const label = z.string().trim().min(1).max(30);
export const termLabelSchema = z.object({ en: label, es: label, tr: label, ru: label, ka: label, pt: label.optional() }).strict();
export type TermLabel = z.infer<typeof termLabelSchema>;

/** A football name a card points to (from the blind readings): what the bot Scout may say for it. */
export const termSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  label: termLabelSchema,
  aliases: z.array(label).max(10).optional(),
}).strict();
export type Term = z.infer<typeof termSchema>;

const cardId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);

/** One private pool item: a picture card and the names it points to. */
export const codenamesCardSchema = z.object({
  id: cardId,
  face: z.boolean(),
  terms: z.array(termSchema).min(1).max(12),
}).strict();
export type CodenamesCard = z.infer<typeof codenamesCardSchema>;

const cardKey = z.enum(['t0', 't1', 'neutral', 'owngoal']);
const keyed = codenamesCardSchema.extend({ key: cardKey }).strict();
export type KeyedCard = z.infer<typeof keyed>;

/**
 * One private pool item of a word board (game codenames, tag `word-<lang>`): a word with a football meaning and an
 * everyday one, and the clues it fits (each clue fits several words of the deck, so one clue can link cards).
 */
export const codenamesWordItemSchema = z.object({
  id: cardId,
  lang: z.enum(ROOM_LOCALES),
  word: z.string().trim().min(1).max(MAX_WORD_CHARS),
  football: z.string().trim().min(1).max(200),
  other: z.string().trim().min(1).max(200),
  clues: z.array(label).min(1).max(12),
}).strict().refine((item) => new Set(item.clues.map((c) => fold(c))).size === item.clues.length, 'duplicate clue');
export type CodenamesWordItem = z.infer<typeof codenamesWordItemSchema>;
export const wordTag = (lang: RoomLocale) => `word-${lang}`;

/** A word card as dealt: its clues become the bot's terms (one room speaks one language, so every label is the clue). */
/** `terms` may be empty: a word whose every clue would break the clue rule on its board gets no bot clue. */
const keyedWord = z.object({ id: cardId, word: z.string().min(1).max(MAX_WORD_CHARS), terms: z.array(termSchema).max(12), key: cardKey }).strict();
export type KeyedWordCard = z.infer<typeof keyedWord>;

/** A match's board, written once when the room starts: cards in board order with their keys, who starts, and the seed
 * of the match's public draws (independent of the key). */
type BoardSpec = { size: number; starting: number; other: number; neutral: number };

function checkSplit(pack: { starting: Team; cards: Array<{ id: string; key: CardKey }> }, spec: BoardSpec, ctx: z.RefinementCtx) {
  const count = (k: CardKey) => pack.cards.filter((c) => c.key === k).length;
  const own = pack.starting === 0 ? ['t0', 't1'] as const : ['t1', 't0'] as const;
  if (count(own[0]) !== spec.starting || count(own[1]) !== spec.other || count('neutral') !== spec.neutral || count('owngoal') !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bad key split' });
  }
  if (new Set(pack.cards.map((c) => c.id)).size !== spec.size) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate card' });
}

const starting = z.union([z.literal(0), z.literal(1)]);
const seed = z.number().int().min(0).max(0xffffffff);
export const picturePackSchema = z.object({ starting, seed, cards: z.array(keyed).length(BOARD_SIZE) }).strict()
  .superRefine((pack, ctx) => checkSplit(pack, PICTURES_BOARD, ctx));
export const wordsPackSchema = z.object({ kind: z.literal('words'), lang: z.enum(ROOM_LOCALES), starting, seed, cards: z.array(keyedWord).length(WORDS_BOARD.size) }).strict()
  .superRefine((pack, ctx) => checkSplit(pack, WORDS_BOARD, ctx));
export type PicturePack = z.infer<typeof picturePackSchema>;
export type WordsPack = z.infer<typeof wordsPackSchema>;
/** A picture board (no `kind`, as every board stored before word boards) or a word board. */
export const codenamesPackSchema = z.union([picturePackSchema, wordsPackSchema]);
export type CodenamesPack = PicturePack | WordsPack;
export const isWordsPack = (pack: CodenamesPack): pack is WordsPack => 'kind' in pack && pack.kind === 'words';

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const teamKey = (team: Team): CardKey => (team === 0 ? 't0' : 't1');
export const other = (team: Team): Team => (team === 0 ? 1 : 0);

/**
 * Keys 8 / 7 / 4 / 1 over the given cards, the starting team and the board order, all from `random` (the deal uses
 * cryptographic randomness: nothing public, like a team shuffle, may be derived from what drew the key). `seed`: what
 * the match's public draws (team shuffles) use, stored with the board.
 */
export function dealBoard(cards: readonly CodenamesCard[], random: () => number, seed: number): PicturePack {
  if (cards.length !== BOARD_SIZE) throw new Error(`codenames: a board needs ${BOARD_SIZE} cards`);
  const { starting, keyed: dealt } = keyCards(cards, PICTURES_BOARD, random);
  return { starting, seed, cards: dealt };
}

/** Keys 9 / 8 / 7 / 1 over 25 words, the same way (the words' clues become the bot's terms). */
export function dealWordBoard(items: readonly CodenamesWordItem[], lang: RoomLocale, random: () => number, seed: number): WordsPack {
  if (items.length !== WORDS_BOARD.size) throw new Error(`codenames: a word board needs ${WORDS_BOARD.size} words`);
  // The bot never says a clue a human could not (the same checks, on this board), and each clue counts once per word.
  const words = items.map((item) => item.word);
  const legal = sayable(words);
  const cards = items.map((item) => ({ id: item.id, word: item.word, terms: botTerms(item.clues, legal) }));
  const { starting, keyed: dealt } = keyCards(cards, WORDS_BOARD, random);
  return { kind: 'words', lang, starting, seed, cards: dealt };
}

function keyCards<C extends object>(cards: readonly C[], spec: BoardSpec, random: () => number): { starting: Team; keyed: Array<C & { key: CardKey }> } {
  const starting: Team = random() < 0.5 ? 0 : 1;
  const keys: CardKey[] = [
    ...Array<CardKey>(spec.starting).fill(teamKey(starting)),
    ...Array<CardKey>(spec.other).fill(teamKey(other(starting))),
    ...Array<CardKey>(spec.neutral).fill('neutral'),
    'owngoal',
  ];
  const order = shuffled(keys, random);
  return { starting, keyed: shuffled(cards, random).map((c, i) => ({ ...c, key: order[i] })) };
}

/** Whether a Scout could give a clue with these words on the board (each distinct clue judged once). */
export function sayable(boardWords: readonly string[]): (clue: string) => boolean {
  const onBoard = boardMatcher(boardWords);
  const judged = new Map<string, boolean>();
  return (clue) => {
    let ok = judged.get(clue);
    if (ok === undefined) {
      ok = clueProblem(clue, new Set()) === null && onBoard(clue) === null;
      judged.set(clue, ok);
    }
    return ok;
  };
}

/** A word's clues as bot terms: only the ones a Scout could give on its board (`legal`), once each. */
export function botTerms(clues: readonly string[], legal: (clue: string) => boolean): Term[] {
  const seen = new Set<string>();
  return clues.flatMap((clue) => {
    if (!legal(clue)) return [];
    const term = clueTerm(clue);
    if (seen.has(term.id)) return [];
    seen.add(term.id);
    return [term];
  });
}

/** Two 32-bit FNV-1a passes in base 36: a stable short id for any script (term and word ids are [a-z0-9-]). */
function hash64(folded: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of folded) {
    const code = ch.codePointAt(0)!;
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x811c9dc5) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

/** The same clue on two cards is one term (so one clue can link them). */
export const clueTerm = (clue: string): Term => {
  const text = tidyClue(clue);
  return { id: `c-${hash64(fold(text))}`, label: { en: text, es: text, tr: text, ru: text, ka: text } };
};

/** A word's pool id: one per language and folded spelling. */
export const wordItemId = (lang: RoomLocale, word: string): string => `w-${lang}-${hash64(fold(word))}`;

/** Case, accents, punctuation and spacing do not make a clue new ("Messi", "messi", "MESSİ"). */
export const fold = (text: string): string =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, '');

export const tidyClue = (text: string): string => text.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();

export type ClueProblem = 'empty' | 'long' | 'words' | 'used' | 'blocked' | 'board';

/**
 * Why a typed clue cannot be given; null when it can. `used`: folded words already said this game. `boardWords`: on a
 * word board, the words still hidden (the original rule: a clue may not be one, contain one or be part of one).
 */
export function clueProblem(text: string, used: ReadonlySet<string>, boardWords: readonly string[] = []): ClueProblem | null {
  const word = tidyClue(text);
  const folded = fold(word);
  if (!folded) return 'empty';
  if ([...word].length > MAX_CLUE_CHARS) return 'long';
  if (word.split(' ').length > MAX_CLUE_WORDS) return 'words';
  if (used.has(folded)) return 'used';
  if (isClueBlocked(word)) return 'blocked';
  if (clueOnBoard(word, boardWords) !== null) return 'board';
  return null;
}

/** The board word a clue gives away: equal to one of its words, or (3+ letters) part of it or containing it. */
export const clueOnBoard = (clue: string, boardWords: readonly string[]): string | null => boardMatcher(boardWords)(clue);

/** `clueOnBoard` for one board, its words folded once. */
export function boardMatcher(boardWords: readonly string[]): (clue: string) => string | null {
  const folded = boardWords.map((word) => [word, fold(word)] as const);
  return (clue) => {
    // Each word of the clue, and the whole clue run together (so "B A R" is BAR).
    const parts = [...tidyClue(clue).split(/[\s\-]+/), clue].map(fold).filter(Boolean);
    for (const [word, w] of folded) {
      if (parts.some((p) => p === w || (p.length >= 3 && w.includes(p)) || (w.length >= 3 && p.includes(w)))) return word;
    }
    return null;
  };
}

/** Every spelling of a term: once the bot has said it (in any language), a Scout cannot say it again, and the other way round. */
export const termSpellings = (term: Term): string[] => [...Object.values(term.label), ...(term.aliases ?? [])].map(fold).filter(Boolean);

export const termLabel = (term: Term, locale: RoomLocale): string => term.label[locale] ?? term.label.en;

export interface BotClue { term: Term; count: number }

const PENALTY: Record<CardKey, number> = { t0: 2, t1: 2, neutral: 1, owngoal: 100 };

/**
 * The bot Scout's clue: the name (from the cards' blind readings) that covers most of the team's cards still hidden,
 * never one that also points at the hidden Own Goal, and fewer rival and neutral cards for the same cover. Never a name
 * said before in this game. Deterministic, so a replayed transition gives the same clue.
 */
export function bestClue(pack: CodenamesPack, revealed: readonly (CardKey | null)[], team: Team, used: ReadonlySet<string>): BotClue | null {
  const mine = teamKey(team);
  const hidden = pack.cards.filter((_, i) => revealed[i] === null);
  const scores = new Map<string, { term: Term; mine: number; bad: number }>();
  for (const card of hidden) {
    for (const term of card.terms) {
      if (termSpellings(term).some((s) => used.has(s))) continue;
      const e = scores.get(term.id) ?? { term, mine: 0, bad: 0 };
      if (card.key === mine) e.mine += 1;
      else e.bad += card.key === teamKey(other(team)) ? PENALTY.t1 : PENALTY[card.key];
      scores.set(term.id, e);
    }
  }
  const best = [...scores.values()]
    .filter((e) => e.mine > 0 && e.bad < PENALTY.owngoal)
    .sort((a, b) => (b.mine * 2 - b.bad) - (a.mine * 2 - a.bad) || b.mine - a.mine || a.term.id.localeCompare(b.term.id))[0];
  return best ? { term: best.term, count: best.mine } : null;
}
