import { z } from 'zod';
import { matchAnswer, turnMsFor, ultimoCategorySchema, UL_ANSWER_MAX_LENGTH, UL_MAX_MISSES, type UltimoCategory } from '../../ultimo/ultimo.match.js';
import {
  other, reject,
  type DuelCtx, type DuelEngine, type DuelLocale, type EngineOutcome, type LocalizedText, type Scores, type Seat, type Step,
} from '../duel.types.js';

export const UL_CATEGORIES = 5;
/** First to this many categories wins (a match is at most UL_CATEGORIES). */
export const UL_TARGET = 3;
/** Category order: easy, medium, hard, medium, easy (the deciders are the easier ones). */
export const UL_TIERS = ['easy', 'medium', 'hard', 'medium', 'easy'] as const;
export const UL_REVEAL_MS = 3_500;
export const UL_CAT_END_MS = 8_000;

const contentSchema = z.object({ rounds: z.array(ultimoCategorySchema).length(UL_CATEGORIES) }).superRefine((value, ctx) => {
  value.rounds.forEach((round, i) => {
    if (round.difficulty !== UL_TIERS[i]) ctx.addIssue({ code: 'custom', message: `category ${i} must be ${UL_TIERS[i]}`, path: ['rounds', i] });
  });
});
export type UltimoDuelContent = z.infer<typeof contentSchema>;

export const ultimoCommandSchema = z.object({
  type: z.literal('answer'),
  cat: z.number().int().min(0).max(UL_CATEGORIES - 1),
  /**
   * The category's attempt count when the player typed (every judged answer, hit or miss, moves it): a double
   * submit or an old screen is stale, never a second miss.
   */
  k: z.number().int().min(0).max(1_000),
  text: z.string().min(1).max(UL_ANSWER_MAX_LENGTH).regex(/[\p{L}\p{N}]/u),
});
export type UltimoCommand = z.infer<typeof ultimoCommandSchema>;

export type UltimoEnd = 'time' | 'misses' | 'complete';
export interface UltimoSaid { seat: Seat; a: number }
export interface UltimoCategoryResult { winner: Seat | null; reason: UltimoEnd; said: number; named: [number, number] }
export interface UltimoAttempt { seat: Seat; kind: 'ok' | 'wrong' | 'repeat' | 'ambiguous'; text: string; a: number | null }

export interface UltimoDuelState {
  v: 1;
  phase: 'reveal' | 'turn' | 'catEnd' | 'over';
  c: number;
  /** Starter of category 0; starters alternate from there. */
  first: Seat;
  turn: Seat;
  said: UltimoSaid[];
  /** Misses in a row of the seat on turn. */
  m: number;
  /** Judged attempts in this category (the command's staleness token). */
  k: number;
  last: UltimoAttempt | null;
  scores: Scores;
  results: UltimoCategoryResult[];
}

export const starterOf = (s: Pick<UltimoDuelState, 'first'>, c: number): Seat => (c % 2 === 0 ? s.first : other(s.first));

const namedBy = (said: UltimoSaid[]): [number, number] => [said.filter((x) => x.seat === 0).length, said.filter((x) => x.seat === 1).length];

/**
 * A category ends: the seat left standing scores (both, when the list was named in full, so a list's length never
 * decides who wins it). The point that reaches UL_TARGET ends the match in the same step: a won match is never
 * left live for its last reveal.
 */
function settle(s: UltimoDuelState, winner: Seat | null, reason: UltimoEnd, rounds: number): Step<UltimoDuelState> {
  const scores: Scores = [s.scores[0] + (winner === null || winner === 0 ? 1 : 0), s.scores[1] + (winner === null || winner === 1 ? 1 : 0)];
  const results = [...s.results, { winner, reason, said: s.said.length, named: namedBy(s.said) }];
  const over = Math.max(...scores) >= UL_TARGET || s.c + 1 >= rounds;
  return { state: { ...s, phase: over ? 'over' : 'catEnd', scores, results }, phase: over ? null : { ms: UL_CAT_END_MS } };
}

const textFor = (value: LocalizedText, locale: DuelLocale): string => value[locale] ?? value.es;

export const ultimoDuelEngine: DuelEngine<UltimoDuelContent, UltimoDuelState, UltimoCommand> = {
  game: 'ultimo',
  version: 1,
  commandSchema: ultimoCommandSchema,

  parseContent: (value) => contentSchema.parse(value),

  start(_content, ctx: DuelCtx) {
    const first: Seat = ctx.rng() < 0.5 ? 0 : 1;
    return {
      state: { v: 1, phase: 'reveal', c: 0, first, turn: first, said: [], m: 0, k: 0, last: null, scores: [0, 0], results: [] },
      phase: { ms: UL_REVEAL_MS },
    };
  },

  apply(s, content, seat, command) {
    if (s.phase !== 'turn') reject('not_turn');
    if (command.cat !== s.c || command.k !== s.k) reject('stale_turn');
    if (seat !== s.turn) reject('not_your_turn');
    const category: UltimoCategory = content.rounds[s.c];
    const match = matchAnswer(category, command.text);
    const k = s.k + 1;
    if (match.kind === 'ambiguous') {
      return { state: { ...s, k, last: { seat, kind: 'ambiguous', text: command.text, a: null } }, phase: 'keep' };
    }
    if (match.kind === 'answer' && !s.said.some((x) => x.a === match.index)) {
      const said = [...s.said, { seat, a: match.index }];
      const next = { ...s, said, k, m: 0, turn: other(seat), last: { seat, kind: 'ok' as const, text: command.text, a: match.index } };
      if (said.length >= category.answers.length) return settle(next, null, 'complete', content.rounds.length);
      return { state: next, phase: { ms: turnMsFor(said.length) } };
    }
    const m = s.m + 1;
    const last: UltimoAttempt = { seat, kind: match.kind === 'answer' ? 'repeat' : 'wrong', text: command.text, a: match.kind === 'answer' ? match.index : null };
    if (m >= UL_MAX_MISSES) return settle({ ...s, k, m, last }, other(seat), 'misses', content.rounds.length);
    return { state: { ...s, k, m, last }, phase: 'keep' };
  },

  expire(s, content) {
    if (s.phase === 'over') reject('game_over');
    if (s.phase === 'reveal') return { state: { ...s, phase: 'turn', turn: starterOf(s, s.c), m: 0 }, phase: { ms: turnMsFor(0) } };
    if (s.phase === 'turn') return settle(s, other(s.turn), 'time', content.rounds.length);
    const c = s.c + 1;
    return { state: { ...s, phase: 'reveal', c, turn: starterOf(s, c), said: [], m: 0, k: 0, last: null }, phase: { ms: UL_REVEAL_MS } };
  },

  view(s, content, _seat, locale) {
    const category = content.rounds[Math.min(s.c, content.rounds.length - 1)];
    const ended = s.phase === 'catEnd' || s.phase === 'over';
    const name = (a: number) => textFor(category.answers[a].display, locale);
    return {
      phase: s.phase,
      category: s.c,
      totalCategories: content.rounds.length,
      target: UL_TARGET,
      difficulty: category.difficulty,
      // The title is public from the reveal on (both see it at once); the list only as it is said, the rest at the end.
      title: textFor(category.title, locale),
      hint: textFor(category.hint, locale),
      total: category.answers.length,
      turn: s.turn,
      starter: starterOf(s, s.c),
      k: s.k,
      misses: s.m,
      turnMs: turnMsFor(s.said.length),
      said: s.said.map((x) => ({ seat: x.seat, name: name(x.a) })),
      last: s.last ? { seat: s.last.seat, kind: s.last.kind, text: s.last.text, name: s.last.a === null ? null : name(s.last.a) } : null,
      missing: ended ? category.answers.map((_, i) => i).filter((i) => !s.said.some((x) => x.a === i)).map(name) : null,
      scores: s.scores,
      results: s.results,
    };
  },

  outcome: (s): EngineOutcome | null => (s.phase === 'over' ? { scores: s.scores, idle: null } : null),
  scores: (s) => s.scores,
};

