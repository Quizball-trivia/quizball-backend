import { z } from 'zod';
import {
  DUEL_LOCALES, other, reject,
  type DuelCtx, type DuelEngine, type DuelLocale, type EngineOutcome, type LocalizedText, type Scores, type Seat, type Step,
} from '../duel.types.js';

export const BM_ROUNDS = 10;
export const BM_CARDS = 16;
export const BM_TARGETS = 12;
/** Round order: 2 easy, 4 medium, 4 hard. With alternating openers each seat opens 1 easy, 2 medium and 2 hard. */
export const BM_TIERS = ['easy', 'easy', 'medium', 'medium', 'medium', 'medium', 'hard', 'hard', 'hard', 'hard'] as const;
export const BM_POINTS = { easy: 1, medium: 2, hard: 3 } as const;
export const BM_TURN_MS = 60_000;
export const BM_REVEAL_MS = 4_000;
/** Consecutive timeouts that count as leaving the match. */
export const BM_TIMEOUT_FORFEIT = 2;

type Difficulty = keyof typeof BM_POINTS;

const text = z.string().trim().min(1).max(200);
const localized = z.object({ es: text, en: text, ka: text, tr: text });

/** One pool item: a category with 16 cards, 12 of which fit (`ok`). */
export const buscaminasRoundSchema = z.object({
  id: z.string().min(1).max(64),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  prompt: localized,
  cards: z.array(z.object({ id: z.string().min(1).max(32), name: text, img: z.string().min(1).max(300) })).length(BM_CARDS),
  ok: z.array(z.string()).length(BM_TARGETS),
}).superRefine((round, ctx) => {
  const ids = new Set(round.cards.map((c) => c.id));
  if (ids.size !== BM_CARDS) ctx.addIssue({ code: 'custom', message: 'duplicate card id', path: ['cards'] });
  if (new Set(round.ok).size !== BM_TARGETS || round.ok.some((id) => !ids.has(id))) {
    ctx.addIssue({ code: 'custom', message: 'ok must be 12 distinct card ids of the round', path: ['ok'] });
  }
});

const contentSchema = z.object({ rounds: z.array(buscaminasRoundSchema).length(BM_ROUNDS) }).superRefine((value, ctx) => {
  value.rounds.forEach((round, i) => {
    if (round.difficulty !== BM_TIERS[i]) ctx.addIssue({ code: 'custom', message: `round ${i} must be ${BM_TIERS[i]}`, path: ['rounds', i] });
  });
});

export type BuscaminasDuelContent = z.infer<typeof contentSchema>;

export const buscaminasCommandSchema = z.object({
  type: z.literal('pick'),
  round: z.number().int().min(0).max(BM_ROUNDS - 1),
  /** How many cards the round had when the player chose: a double tap or an old screen is stale, not a second pick. */
  at: z.number().int().min(0).max(BM_CARDS),
  cardId: z.string().min(1).max(32),
});
export type BuscaminasCommand = z.infer<typeof buscaminasCommandSchema>;

export interface BuscaminasPick { card: string; seat: Seat; auto: boolean }
export interface BuscaminasRoundResult { outcome: 'mine' | 'cleared'; by: Seat | null; points: Scores }

export interface BuscaminasDuelState {
  v: 1;
  phase: 'turn' | 'reveal' | 'over';
  r: number;
  /** Opener of round 0; openers alternate from there. */
  first: Seat;
  turn: Seat;
  picks: BuscaminasPick[];
  scores: Scores;
  results: BuscaminasRoundResult[];
  timeouts: [number, number];
  idle: Seat | null;
}

export const openerOf = (s: Pick<BuscaminasDuelState, 'first'>, round: number): Seat => (round % 2 === 0 ? s.first : other(s.first));

const tierPoints = (content: BuscaminasDuelContent, r: number): number => BM_POINTS[content.rounds[r].difficulty as Difficulty];

function pickCard(s: BuscaminasDuelState, content: BuscaminasDuelContent, seat: Seat, card: string, auto: boolean): Step<BuscaminasDuelState> {
  const round = content.rounds[s.r];
  const picks = [...s.picks, { card, seat, auto }];
  const value = tierPoints(content, s.r);
  if (!round.ok.includes(card)) {
    const points: Scores = seat === 0 ? [0, value] : [value, 0];
    return settle({ ...s, picks }, { outcome: 'mine', by: seat, points });
  }
  const found = picks.filter((p) => round.ok.includes(p.card)).length;
  if (found >= BM_TARGETS) return settle({ ...s, picks }, { outcome: 'cleared', by: null, points: [value, value] });
  return { state: { ...s, picks, turn: other(seat) }, phase: { ms: BM_TURN_MS } };
}

function settle(s: BuscaminasDuelState, result: BuscaminasRoundResult): Step<BuscaminasDuelState> {
  return {
    state: { ...s, phase: 'reveal', results: [...s.results, result], scores: [s.scores[0] + result.points[0], s.scores[1] + result.points[1]] },
    phase: { ms: BM_REVEAL_MS },
  };
}

const textFor = (value: LocalizedText, locale: DuelLocale): string => value[locale] ?? value.es;

export const buscaminasDuelEngine: DuelEngine<BuscaminasDuelContent, BuscaminasDuelState, BuscaminasCommand> = {
  game: 'buscaminas',
  version: 1,
  commandSchema: buscaminasCommandSchema,

  parseContent: (value) => contentSchema.parse(value),

  start(_content, ctx: DuelCtx) {
    const first: Seat = ctx.rng() < 0.5 ? 0 : 1;
    return {
      state: { v: 1, phase: 'turn', r: 0, first, turn: first, picks: [], scores: [0, 0], results: [], timeouts: [0, 0], idle: null },
      phase: { ms: BM_TURN_MS },
    };
  },

  apply(s, content, seat, command) {
    if (s.phase !== 'turn') reject('round_over');
    if (command.round !== s.r || command.at !== s.picks.length) reject('stale_turn');
    if (seat !== s.turn) reject('not_your_turn');
    const round = content.rounds[s.r];
    if (!round.cards.some((c) => c.id === command.cardId)) reject('unknown_card');
    if (s.picks.some((p) => p.card === command.cardId)) reject('already_picked');
    const timeouts: [number, number] = [...s.timeouts];
    timeouts[seat] = 0;
    return pickCard({ ...s, timeouts }, content, seat, command.cardId, false);
  },

  expire(s, content, ctx) {
    if (s.phase === 'over') reject('game_over');
    if (s.phase === 'reveal') {
      const r = s.r + 1;
      if (r >= BM_ROUNDS) return { state: { ...s, phase: 'over' }, phase: null };
      return { state: { ...s, phase: 'turn', r, picks: [], turn: openerOf(s, r) }, phase: { ms: BM_TURN_MS } };
    }
    const seat = s.turn;
    const timeouts: [number, number] = [...s.timeouts];
    timeouts[seat] += 1;
    if (timeouts[seat] >= BM_TIMEOUT_FORFEIT) return { state: { ...s, timeouts, phase: 'over', idle: seat }, phase: null };
    const open = content.rounds[s.r].cards.filter((c) => !s.picks.some((p) => p.card === c.id));
    const card = open[Math.min(open.length - 1, Math.floor(ctx.rng() * open.length))];
    return pickCard({ ...s, timeouts }, content, seat, card.id, true);
  },

  view(s, content, _seat, locale) {
    const round = content.rounds[Math.min(s.r, BM_ROUNDS - 1)];
    const revealAll = s.phase !== 'turn';
    return {
      phase: s.phase,
      round: s.r,
      totalRounds: BM_ROUNDS,
      difficulty: round.difficulty,
      points: tierPoints(content, Math.min(s.r, BM_ROUNDS - 1)),
      prompt: textFor(round.prompt, locale),
      opener: openerOf(s, s.r),
      turn: s.turn,
      pickIndex: s.picks.length,
      found: s.picks.filter((p) => round.ok.includes(p.card)).length,
      needed: BM_TARGETS,
      cards: round.cards.map((card) => {
        const pick = s.picks.find((p) => p.card === card.id);
        const fits = pick || revealAll ? round.ok.includes(card.id) : null;
        return { id: card.id, name: card.name, img: card.img, pick: pick ? { seat: pick.seat, auto: pick.auto } : null, fits };
      }),
      results: s.results,
      scores: s.scores,
      timeouts: s.timeouts,
    };
  },

  outcome: (s): EngineOutcome | null => (s.phase === 'over' ? { scores: s.scores, idle: s.idle } : null),
  scores: (s) => s.scores,
};

export const BUSCAMINAS_DUEL_LOCALES = DUEL_LOCALES;
