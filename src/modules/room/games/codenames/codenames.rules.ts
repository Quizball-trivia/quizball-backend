import { z } from 'zod';
import { isClueBlocked } from './codenames.moderation.js';
import type { RoomLocale } from '../../room.types.js';

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

// A name the bot says must fit the clue limit a Scout has.
const label = z.string().trim().min(1).max(30);
export const termLabelSchema = z.object({ en: label, es: label, tr: label, ru: label, ka: label }).strict();
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

const keyed = codenamesCardSchema.extend({ key: z.enum(['t0', 't1', 'neutral', 'owngoal']) }).strict();
export type KeyedCard = z.infer<typeof keyed>;

/** A match's board, written once when the room starts: cards in board order with their keys, who starts, and the seed
 * of the match's public draws (independent of the key). */
export const codenamesPackSchema = z.object({
  starting: z.union([z.literal(0), z.literal(1)]),
  seed: z.number().int().min(0).max(0xffffffff),
  cards: z.array(keyed).length(BOARD_SIZE),
}).strict().superRefine((pack, ctx) => {
  const count = (k: CardKey) => pack.cards.filter((c) => c.key === k).length;
  const own = pack.starting === 0 ? ['t0', 't1'] as const : ['t1', 't0'] as const;
  if (count(own[0]) !== STARTING_TEAM_CARDS || count(own[1]) !== OTHER_TEAM_CARDS || count('neutral') !== NEUTRAL_CARDS || count('owngoal') !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bad key split' });
  }
  if (new Set(pack.cards.map((c) => c.id)).size !== BOARD_SIZE) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate card' });
});
export type CodenamesPack = z.infer<typeof codenamesPackSchema>;

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
export function dealBoard(cards: readonly CodenamesCard[], random: () => number, seed: number): CodenamesPack {
  if (cards.length !== BOARD_SIZE) throw new Error(`codenames: a board needs ${BOARD_SIZE} cards`);
  const starting: Team = random() < 0.5 ? 0 : 1;
  const keys: CardKey[] = [
    ...Array<CardKey>(STARTING_TEAM_CARDS).fill(teamKey(starting)),
    ...Array<CardKey>(OTHER_TEAM_CARDS).fill(teamKey(other(starting))),
    ...Array<CardKey>(NEUTRAL_CARDS).fill('neutral'),
    'owngoal',
  ];
  const order = shuffled(keys, random);
  return { starting, seed, cards: shuffled(cards, random).map((c, i) => ({ ...c, key: order[i] })) };
}

/** Case, accents, punctuation and spacing do not make a clue new ("Messi", "messi", "MESSİ"). */
export const fold = (text: string): string =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, '');

export const tidyClue = (text: string): string => text.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();

export type ClueProblem = 'empty' | 'long' | 'words' | 'used' | 'blocked';

/** Why a typed clue cannot be given; null when it can. `used`: folded words already said this game. */
export function clueProblem(text: string, used: ReadonlySet<string>): ClueProblem | null {
  const word = tidyClue(text);
  const folded = fold(word);
  if (!folded) return 'empty';
  if ([...word].length > MAX_CLUE_CHARS) return 'long';
  if (word.split(' ').length > MAX_CLUE_WORDS) return 'words';
  if (used.has(folded)) return 'used';
  if (isClueBlocked(word)) return 'blocked';
  return null;
}

/** Every spelling of a term: once the bot has said it (in any language), a Scout cannot say it again, and the other way round. */
export const termSpellings = (term: Term): string[] => [...Object.values(term.label), ...(term.aliases ?? [])].map(fold).filter(Boolean);

export const termLabel = (term: Term, locale: RoomLocale): string => term.label[locale];

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
