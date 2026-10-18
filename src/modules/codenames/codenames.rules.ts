import { rejected } from '../daily/daily.errors.js';
import type { DayBoard, PublicRunState, RunFlip, RunState } from './codenames.types.js';

/**
 * The daily board, pure: the bot gives the day's clues in order; you flip cards. Your card lets you go on (up to the
 * clue's count + 1 flips); a rival or neutral card ends that clue; the Own Goal ends the run. You may stop a clue after
 * one flip. The run ends when all your cards are found, on the Own Goal, or after the last clue. The score orders the
 * board: more cards found first, then fewer misses.
 */
export const newState = (): RunState => ({ v: 1, flips: [], clue: 0, done: false, end: null });

const onClue = (s: RunState) => s.flips.filter((f) => f.clue === s.clue).length;
export const found = (s: RunState) => s.flips.filter((f) => f.kind === 'mine').length;
export const misses = (s: RunState) => s.flips.filter((f) => f.kind !== 'mine').length;
/** Your cards on every board (a finished run whose day was corrected since has no board, but still had eight). */
const MINE = 8;
const total = (day: DayBoard | null) => (day ? day.cards.filter((c) => c.kind === 'mine').length : MINE);
export const guessesLeft = (s: RunState, day: DayBoard) => (s.done ? 0 : day.clues[s.clue].count + 1 - onClue(s));

function nextClue(s: RunState, day: DayBoard): RunState {
  const clue = s.clue + 1;
  return clue >= day.clues.length ? { ...s, done: true, end: 'clues' } : { ...s, clue };
}

export function flip(s: RunState, day: DayBoard, card: number): RunState {
  if (s.done) throw rejected('run_done');
  const target = day.cards[card];
  if (!target) throw rejected('unknown_card');
  if (s.flips.some((f) => f.card === card)) throw rejected('card_flipped');
  const flips: RunFlip[] = [...s.flips, { card, kind: target.kind, clue: s.clue }];
  const next: RunState = { ...s, flips };
  if (target.kind === 'owngoal') return { ...next, done: true, end: 'owngoal' };
  if (found(next) === total(day)) return { ...next, done: true, end: 'complete' };
  if (target.kind !== 'mine' || guessesLeft(next, day) === 0) return nextClue(next, day);
  return next;
}

export function stop(s: RunState, day: DayBoard): RunState {
  if (s.done) throw rejected('run_done');
  if (onClue(s) === 0) throw rejected('no_flip');
  return nextClue(s, day);
}

/** A correction moved an unfinished run onto new content (unranked by then): the new board starts over. */
export const rebase = (_s: RunState): RunState => newState();

/** Cards found × 100 + (99 − misses): 8 found without a miss = 899. */
export const score = (s: RunState): number => found(s) * 100 + Math.max(0, 99 - misses(s));

/**
 * What the player sees. A card's kind only once it is flipped; the clues up to the current one; the cards each clue
 * meant and their why only when the run is over (before that they would point at cards still hidden). A closed day
 * discloses nothing more while the run is still being played.
 */
export function publicState(s: RunState, dayId: string, day: DayBoard | null, extra: { ranked: boolean; rank?: number }): PublicRunState {
  const flipped = new Map(s.flips.map((f) => [f.card, f.kind]));
  const reached = s.done ? day?.clues.length ?? 0 : s.clue + 1;
  return {
    day: dayId,
    cards: (day?.cards ?? []).map((c, i) => ({ id: c.id, kind: s.done ? c.kind : flipped.get(i) ?? null })),
    clues: (day?.clues ?? []).slice(0, reached).map((c) => (s.done ? { word: c.word, count: c.count, cards: c.cards } : { word: c.word, count: c.count })),
    totalClues: day?.clues.length ?? 0,
    clue: s.clue,
    guessesLeft: day ? guessesLeft(s, day) : 0,
    flips: s.flips,
    done: s.done,
    end: s.end,
    found: found(s),
    total: total(day),
    misses: misses(s),
    score: score(s),
    ranked: extra.ranked,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
