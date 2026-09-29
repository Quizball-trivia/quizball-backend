import type { z } from 'zod';

export const DUEL_GAMES = ['buscaminas', 'pistas', 'ultimo'] as const;
export type DuelGameId = (typeof DUEL_GAMES)[number];

export const DUEL_LOCALES = ['es', 'en', 'ka', 'tr'] as const;
export type DuelLocale = (typeof DUEL_LOCALES)[number];
export type LocalizedText = Record<DuelLocale, string>;

/** Seat index inside engines; stored as seat 1 | 2 in duel_participants. */
export type Seat = 0 | 1;
export const other = (seat: Seat): Seat => (seat === 0 ? 1 : 0);

export type Scores = [number, number];

/** Deterministic randomness: the runtime derives it from the match seed and a persisted counter. */
export interface DuelCtx {
  rng: () => number;
  /** Milliseconds left in the open phase (0 when it has expired). */
  remainingMs: number;
}

/**
 * The next phase: a fresh clock of `ms`, `keep` (same deadline, same phase token), or null when the game is over.
 * The runtime turns `ms` into an absolute database deadline and a new phase token.
 */
export type PhaseClock = { ms: number } | 'keep' | null;

export interface Step<S> {
  state: S;
  phase: PhaseClock;
}

/** Why the game ended by itself: on the scores, or one seat stopped playing. */
export type EngineOutcome = { scores: Scores; idle: Seat | null };

export class DuelRuleError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export const reject = (code: string): never => {
  throw new DuelRuleError(code);
};

/**
 * A duel game's rules, pure: no I/O, no clocks, no randomness except ctx.rng. The runtime owns the
 * lifecycle, the absolute deadline, the phase token, idempotency and forfeits; the engine owns the game.
 */
export interface DuelEngine<Content, State, Command> {
  game: DuelGameId;
  version: number;
  commandSchema: z.ZodType<Command>;
  /** Validates and freezes a picked pack (JSON only: it is stored in duel_match_content). */
  parseContent(value: unknown): Content;
  start(content: Content, ctx: DuelCtx): Step<State>;
  apply(state: State, content: Content, seat: Seat, command: Command, ctx: DuelCtx): Step<State>;
  /** The phase clock ran out. */
  expire(state: State, content: Content, ctx: DuelCtx): Step<State>;
  /** What `seat` sees (null: a spectator-safe view). Never an answer the game has not revealed. */
  view(state: State, content: Content, seat: Seat | null, locale: DuelLocale): unknown;
  outcome(state: State): EngineOutcome | null;
  scores(state: State): Scores;
}
