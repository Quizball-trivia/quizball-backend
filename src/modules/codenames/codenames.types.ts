import { z } from 'zod';
import type { AvatarCustomization } from '../users/avatar-customization.js';
import { BOARD_SIZE, MAX_CLUE_CHARS, type TermLabel } from '../room/games/codenames/codenames.rules.js';

export type DayKind = 'mine' | 'theirs' | 'neutral' | 'owngoal';
const cardId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
const why = z.string().trim().min(1).max(140);
const localized = <T extends z.ZodTypeAny>(t: T) => z.object({ en: t, es: t, tr: t, ru: t, ka: t }).strict();
const clueWord = z.string().trim().min(1).max(MAX_CLUE_CHARS);

/**
 * One day's board, self-contained: the 20 cards with their key (8 yours, 7 rival, 4 neutral, the Own Goal) and the
 * bot's clues, each naming the cards it means. Server-only: a card's kind reaches a player when it is flipped, a clue
 * when its turn comes, and the cards behind a clue (with its why) when the run is over.
 */
export const dayBoardSchema = z.object({
  cards: z.array(z.object({ id: cardId, kind: z.enum(['mine', 'theirs', 'neutral', 'owngoal']) }).strict()).length(BOARD_SIZE),
  clues: z.array(z.object({
    word: localized(clueWord),
    count: z.number().int().min(1).max(4),
    /** The cards the clue means, each with the football reason behind it. */
    cards: z.array(z.object({ id: cardId, why: localized(why) }).strict()).min(1).max(4),
  }).strict()).min(2).max(5),
}).strict().superRefine((d, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const count = (k: DayKind) => d.cards.filter((c) => c.kind === k).length;
  if (count('mine') !== 8 || count('theirs') !== 7 || count('neutral') !== 4 || count('owngoal') !== 1) issue('key must be 8/7/4/1');
  if (new Set(d.cards.map((c) => c.id)).size !== BOARD_SIZE) issue('duplicate card');
  const mine = new Set(d.cards.filter((c) => c.kind === 'mine').map((c) => c.id));
  const meant = d.clues.flatMap((c) => c.cards.map((x) => x.id));
  if (d.clues.some((c) => c.cards.length !== c.count)) issue('a clue count must match its cards');
  if (new Set(meant).size !== meant.length || meant.length !== mine.size || meant.some((id) => !mine.has(id))) issue('the clues must cover your cards once each');
});
export type DayBoard = z.infer<typeof dayBoardSchema>;

/** One codenames_days row. */
export interface CodenamesDayRow { day: string; number: number; contentVersion: number; board: unknown }

export type Player = { kind: 'member'; userId: string } | { kind: 'guest'; guestId: string };

/** One flip, kept whole: what the player saw is never re-read from the day's current content. */
export interface RunFlip { card: number; kind: DayKind; clue: number }

/** codenames_runs.state. The guesses left follow from the flips on the current clue. */
export interface RunState { v: 1; flips: RunFlip[]; clue: number; done: boolean; end: 'complete' | 'owngoal' | 'clues' | null }

export interface PublicClue { word: TermLabel; count: number; cards?: Array<{ id: string; why: TermLabel }> }

export interface PublicRunState {
  day: string;
  /** Board order; `kind` once flipped, or for every card once the run is over. */
  cards: Array<{ id: string; kind: DayKind | null }>;
  /** Clues up to the current one (word and count); every clue with its cards and their whys once the run is over. */
  clues: PublicClue[];
  totalClues: number;
  clue: number;
  guessesLeft: number;
  flips: RunFlip[];
  done: boolean;
  end: RunState['end'];
  found: number;
  total: number;
  misses: number;
  score: number;
  ranked: boolean;
  rank?: number;
}

export interface CodenamesRunRow {
  id: string;
  user_id: string | null;
  guest_id: string | null;
  day: string;
  ranked: boolean;
  content_version: number;
  state: RunState;
  state_version: number;
  done: boolean;
  score: number | null;
  misses: number | null;
  completed_at: Date | null;
  closes_at: Date;
  closed: boolean;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization: AvatarCustomization | null;
  country: string | null;
  tier: string | null;
  score: number;
  misses: number;
}

/** A closed day: the whole board. */
export interface ReviewResponse { day: string; cards: DayBoard['cards']; clues: DayBoard['clues'] }
