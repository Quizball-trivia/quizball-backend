import { z } from 'zod';
import type { RoomEngineStanding, RoomSeatChange, RoomSeatStatus } from '../../room.engine.js';
import type { RoomLocale } from '../../room.types.js';
import { CARDS, type CardId } from './engine/zoneMatch.cards.js';
import {
  IDLE, reducer, type Action, type Category, type Content, type MatchState, type NumericItem,
} from './engine/zoneMatch.machine.js';
import { RULES, setRules } from './engine/zoneMatch.playtest.js';
import { MATCH_ROUNDS } from './engine/zoneMatch.rules.js';
import { withRandom } from './engine/zoneMatch.random.js';
import { shootoutGoals } from './engine/zoneMatch.shootout.js';
import { seatView } from './engine/zoneMatch.view.js';

/**
 * Zone match (Ranked 2.0 beta) on the room runtime: a 1v1, server-run with the web's own engine (engine/, copied).
 * Seat 0 plays as the engine's "player", seat 1 as its "opponent"; each seat's view is turned round so it is always
 * "player". The match: a loadout pick, then the engine (showdown → reveal → categories → line-up → ten attacks → a
 * shootout when level). Every step runs inside `withRandom` on a seed of the match, with the match's frozen rules.
 */

/** Picking the loadout before the showdown. */
export const LOADOUT_MS = 30_000;
/** A deadline this far overdue is an outage: the open step gets a fresh window, nobody is charged. */
export const OUTAGE_MS = 5_000;
/** The step that's always pending while nothing is scheduled (the runtime needs a deadline). */
const IDLE_MS = 60_000;

const CARD_IDS = CARDS.map((card) => card.id) as [CardId, ...CardId[]];
const cardId = z.enum(CARD_IDS);
const i18n = z.record(z.string().max(400));

/** One MCQ in every language the pool has; the engine works on ids, a seat's view gets its language's text. */
const mcqSchema = z.object({
  id: z.string().min(1).max(64),
  categoryId: z.string().min(1).max(64),
  prompt: i18n,
  options: z.array(i18n).length(4),
  correctIndex: z.number().int().min(0).max(3),
}).strict();
export type ZoneMcq = z.infer<typeof mcqSchema>;

/** One number question of the private pool (room_pool, game zone_match), as seeded and as dealt. */
export const zoneNumericItemSchema = z.object({
  id: z.string().min(1).max(64),
  prompt: i18n.refine((t) => typeof t.en === 'string' && t.en.length > 0, 'English text required'),
  unit: i18n,
  value: z.number().finite(),
  step: z.number().positive().optional(),
  precision: z.number().int().min(0).max(3),
}).strict();
const numericSchema = zoneNumericItemSchema.extend({ step: z.number().positive() });

const categorySchema = z.object({ id: z.string().min(1).max(64), name: i18n, imageUrl: z.string().nullable(), icon: z.string().nullable() }).strict();

export const zoneMatchPackSchema = z.object({
  seed: z.number().int().min(0).max(0xffffffff),
  categories: z.array(categorySchema).min(10).max(24),
  mcqs: z.array(mcqSchema).min(20),
  fallback: z.array(z.string()).min(10),
  numerics: z.array(numericSchema).min(5),
  rules: z.object({
    counters: z.boolean(), downsides: z.boolean(), attackerWinsTies: z.boolean(), energy: z.boolean(), hiddenLoadouts: z.boolean(),
    bicycle: z.enum(['comeback', 'faster']),
  }).strict(),
}).strict();
export type ZoneMatchContent = z.infer<typeof zoneMatchPackSchema>;

/** Every command names the moment it was sent for (a late or repeated one never lands on the next). */
export const zoneMatchCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('loadout'), cards: z.array(cardId).max(3) }).strict(),
  z.object({ type: z.literal('category'), round: z.number().int().min(0).max(20), categoryId: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('card'), duel: z.number().int().min(0).max(200), card: cardId.nullable() }).strict(),
  z.object({ type: z.literal('reaction'), duel: z.number().int().min(0).max(200), card: cardId }).strict(),
  /** A live card is for the question on screen (`key`): a Substitution in between must not catch it. */
  z.object({ type: z.literal('live'), duel: z.number().int().min(0).max(200), key: z.number().int().min(0), card: cardId }).strict(),
  z.object({ type: z.literal('home'), duel: z.number().int().min(0).max(200), categoryId: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('answer'), key: z.number().int().min(0), index: z.number().int().min(0).max(3) }).strict(),
  z.object({ type: z.literal('guess'), key: z.number().int().min(0), value: z.number().finite().min(-1e9).max(1e9) }).strict(),
]);
export type ZoneMatchCommand = z.infer<typeof zoneMatchCommandSchema>;

export interface ZoneMatchEnd { reason: 'score' | 'left'; loser: number | null }

export interface ZoneMatchState {
  phase: 'loadout' | 'match' | 'over' | 'cancelled';
  deadline: number;
  status: RoomSeatStatus[];
  /** Each seat's loadout (null until picked). */
  loadouts: (CardId[] | null)[];
  match: MatchState;
  /** Engine steps taken (each draws its chance from seed + steps). */
  steps: number;
  end: ZoneMatchEnd | null;
}

const SIDES = ['player', 'opponent'] as const;
const sideOf = (seat: number) => SIDES[seat];
const other = (seat: number) => (seat === 0 ? 1 : 0);
const ended = (s: ZoneMatchState) => s.phase === 'over' || s.phase === 'cancelled';

/** The engine's content: questions by category with placeholder text (the view puts the seat's language in). */
export function engineContent(content: ZoneMatchContent): Content {
  const toQuestion = (q: ZoneMcq) => ({ id: q.id, prompt: '', options: ['', '', '', ''], correctIndex: q.correctIndex, categoryId: q.categoryId });
  const mcqByCategory: Content['mcqByCategory'] = {};
  for (const q of content.mcqs) (mcqByCategory[q.categoryId] ??= []).push(toQuestion(q));
  const byId = new Map(content.mcqs.map((q) => [q.id, q]));
  return {
    mcqByCategory,
    fallbackMcqs: content.fallback.flatMap((id) => (byId.has(id) ? [toQuestion(byId.get(id)!)] : [])),
    numerics: content.numerics as NumericItem[],
  };
}

const categoriesOf = (content: ZoneMatchContent, locale: RoomLocale): Category[] =>
  content.categories.map((c) => ({ id: c.id, name: c.name[locale] ?? c.name.en ?? Object.values(c.name)[0] ?? '', imageUrl: c.imageUrl, icon: c.icon }));

/** One engine step with this match's rules and chance. */
function step(s: ZoneMatchState, content: ZoneMatchContent, action: Action): ZoneMatchState {
  const saved = { ...RULES };
  setRules(content.rules);
  try {
    const match = withRandom((content.seed + s.steps * 0x9e3779b1) >>> 0, () => reducer(s.match, action));
    return { ...s, match, steps: s.steps + 1, deadline: match.advanceAt ?? s.deadline };
  } finally {
    setRules(saved);
  }
}

function deadlineOf(s: ZoneMatchState, nowMs: number): number {
  return s.match.advanceAt ?? nowMs + IDLE_MS;
}

export function startMatch(seats: number, _content: ZoneMatchContent, nowMs: number): ZoneMatchState {
  if (seats !== 2) throw new Error('A zone match room needs exactly 2 admitted seats');
  return { phase: 'loadout', deadline: nowMs + LOADOUT_MS, status: ['in', 'in'], loadouts: [null, null], match: IDLE, steps: 0, end: null };
}

/** Both loadouts in (or the pick ran out): the match proper starts (an empty loadout is filled at random). */
function kickOff(s: ZoneMatchState, content: ZoneMatchContent, nowMs: number): ZoneMatchState {
  const started = step({ ...s, phase: 'match' }, content, {
    type: 'RESTART',
    categoryPool: categoriesOf(content, 'en'),
    decks: { player: s.loadouts[0] ?? [], opponent: s.loadouts[1] ?? [] },
    windowMode: 'round',
    now: nowMs,
  });
  return { ...started, deadline: deadlineOf(started, nowMs) };
}

function finishIfOver(s: ZoneMatchState): ZoneMatchState {
  if (s.phase === 'match' && s.match.stage === 'fulltime') return { ...s, phase: 'over', end: { reason: 'score', loser: null } };
  return s;
}

/** Moves the clock one boundary: the loadout pick, or the engine's next scheduled step. */
export function tick(s: ZoneMatchState, content: ZoneMatchContent, nowMs: number): ZoneMatchState {
  if (ended(s) || nowMs < s.deadline) return s;
  if (s.phase === 'loadout') return kickOff(s, content, nowMs);
  if (s.match.advanceAt === null) return { ...finishIfOver(s), deadline: nowMs + IDLE_MS };
  const next = step(s, content, { type: 'ADVANCE', content: engineContent(content), now: nowMs });
  return finishIfOver({ ...next, deadline: deadlineOf(next, nowMs) });
}

/**
 * The open step gets a fresh window: an open question or number question starts again from now (everything already
 * locked in keeps its time on that question, so no answer earns more for the outage); any other step moves on by the
 * time lost, plus a moment.
 */
export function afterOutage(s: ZoneMatchState, nowMs: number): ZoneMatchState {
  if (ended(s)) return s;
  if (s.phase === 'loadout') return { ...s, deadline: nowMs + LOADOUT_MS };
  const m = s.match;
  const openMcq = m.mcq && m.battleStep === 'mcq' ? m.mcq : null;
  const openNumeric = m.numeric && !m.numeric.result && m.battleStep === 'numeric' ? m.numeric : null;
  const lost = openMcq ? nowMs - openMcq.startedAt : openNumeric ? nowMs - openNumeric.startedAt : Math.max(0, nowMs - s.deadline) + OUTAGE_MS;
  if (lost <= 0) return s;
  const by = (t: number | null) => (t === null ? null : t + lost);
  const perSide = <T extends Record<'player' | 'opponent', number | null>>(r: T): T => ({ ...r, player: by(r.player), opponent: by(r.opponent) });
  const match: MatchState = {
    ...m,
    advanceAt: by(m.advanceAt),
    mcq: m.mcq ? { ...m.mcq, startedAt: m.mcq.startedAt + lost, deadline: m.mcq.deadline + lost, answeredAt: perSide(m.mcq.answeredAt), hiddenAt: perSide(m.mcq.hiddenAt) } : null,
    numeric: m.numeric
      ? {
          ...m.numeric,
          startedAt: m.numeric.startedAt + lost,
          deadline: m.numeric.deadline + lost,
          guesses: {
            player: { ...m.numeric.guesses.player, lockedAtMs: by(m.numeric.guesses.player.lockedAtMs) },
            opponent: { ...m.numeric.guesses.opponent, lockedAtMs: by(m.numeric.guesses.opponent.lockedAtMs) },
          },
        }
      : null,
  };
  return { ...s, match, deadline: match.advanceAt ?? nowMs + IDLE_MS };
}

const live = (s: ZoneMatchState) => s.status.flatMap((st, seat) => (st === 'withdrawn' ? [] : [seat]));

/** A seat that leaves loses (while the other is here); nobody left cancels. Away seats just don't answer. */
export function seatsChanged(s: ZoneMatchState, changes: readonly RoomSeatChange[]): ZoneMatchState {
  if (ended(s)) return s;
  const status = [...s.status];
  for (const { seat, change } of changes) {
    if (status[seat] === 'withdrawn') continue;
    status[seat] = change === 'leave' ? 'withdrawn' : change === 'away' ? 'away' : 'in';
  }
  const next = { ...s, status };
  const seats = live(next);
  if (seats.length === 0) return { ...next, phase: 'cancelled' };
  if (seats.length === 1) return { ...next, phase: 'over', end: { reason: 'left', loser: other(seats[0]) } };
  return next;
}

export type ZoneMatchCommandError = 'not_open' | 'withdrawn' | 'stale' | 'rejected';

export function applyCommand(s: ZoneMatchState, content: ZoneMatchContent, seat: number, cmd: ZoneMatchCommand, nowMs: number): { state: ZoneMatchState; error?: ZoneMatchCommandError } {
  if (ended(s)) return { state: s, error: 'not_open' };
  if (s.status[seat] === 'withdrawn') return { state: s, error: 'withdrawn' };
  const side = sideOf(seat);
  if (cmd.type === 'loadout') {
    if (s.phase !== 'loadout' || s.loadouts[seat]) return { state: s, error: 'not_open' };
    const loadouts = s.loadouts.map((l, i) => (i === seat ? [...cmd.cards] : l));
    const next = { ...s, loadouts };
    return { state: loadouts.every(Boolean) ? kickOff(next, content, nowMs) : next };
  }
  if (s.phase !== 'match') return { state: s, error: 'not_open' };
  const m = s.match;
  let action: Action;
  switch (cmd.type) {
    case 'category':
      if (cmd.round !== m.round) return { state: s, error: 'stale' };
      action = { type: 'PICK_CATEGORY', side, categoryId: cmd.categoryId, content: engineContent(content), now: nowMs };
      break;
    case 'card':
      if (cmd.duel !== m.duelNo) return { state: s, error: 'stale' };
      action = { type: 'CHOOSE_CARD', side, card: cmd.card, now: nowMs };
      break;
    case 'reaction':
      if (cmd.duel !== m.duelNo) return { state: s, error: 'stale' };
      action = { type: 'PLAY_REACTION', side, card: cmd.card, now: nowMs };
      break;
    case 'live':
      if (cmd.duel !== m.duelNo || !m.mcq || cmd.key !== m.mcq.key) return { state: s, error: 'stale' };
      action = { type: 'PLAY_LIVE', side, card: cmd.card, content: engineContent(content), now: nowMs };
      break;
    case 'home':
      if (cmd.duel !== m.duelNo) return { state: s, error: 'stale' };
      action = { type: 'CHOOSE_HOME_CATEGORY', side, categoryId: cmd.categoryId };
      break;
    case 'answer':
      if (!m.mcq || cmd.key !== m.mcq.key) return { state: s, error: 'stale' };
      action = { type: 'ANSWER', side, index: cmd.index, questionId: m.mcq.question.id, now: nowMs };
      break;
    case 'guess':
      if (!m.numeric || cmd.key !== m.numeric.key) return { state: s, error: 'stale' };
      action = { type: 'GUESS', side, value: cmd.value, now: nowMs };
      break;
  }
  const next = step(s, content, action);
  // The engine leaves a move it doesn't accept untouched.
  if (next.match === m) return { state: s, error: 'rejected' };
  return { state: finishIfOver({ ...next, deadline: deadlineOf(next, nowMs) }) };
}

export function winnerOf(s: ZoneMatchState): number | null {
  if (s.phase !== 'over' || !s.end) return null;
  if (s.end.loser !== null) return other(s.end.loser);
  const pens = s.match.shootout?.winner;
  if (pens) return pens === 'player' ? 0 : 1;
  const { player, opponent } = s.match.score;
  return player === opponent ? null : player > opponent ? 0 : 1;
}

/** Goals as points (penalties as round wins); a seat that left is second. */
export function standings(s: ZoneMatchState): RoomEngineStanding[] {
  const winner = winnerOf(s);
  const pens = s.match.shootout ? shootoutGoals(s.match.shootout.kicks) : null;
  return s.status.map((_, seat) => ({
    seat,
    points: s.match.score[sideOf(seat)],
    roundWins: pens ? pens[sideOf(seat)] : 0,
    place: winner === null || winner === seat ? 1 : 2,
  }));
}

export interface ZoneMatchView {
  phase: ZoneMatchState['phase'];
  deadline: number;
  you: number;
  rounds: number;
  /** Your loadout is in / theirs is in (the cards themselves show at the showdown). */
  loadoutIn: { you: boolean; them: boolean };
  match: MatchState;
  opponentAnswered: boolean;
  opponentGuessed: boolean;
  /** The question and its options in your language (the engine works on ids). */
  question: { prompt: string; options: string[] } | null;
  categories: Category[];
  end: { winner: 'you' | 'them' | null; reason: ZoneMatchEnd['reason'] } | null;
}

const text = (field: Record<string, string>, locale: RoomLocale) => field[locale] ?? field.en ?? Object.values(field)[0] ?? '';

export function viewOf(s: ZoneMatchState, content: ZoneMatchContent, seat: number, locale: RoomLocale): ZoneMatchView {
  const seen = seatView(s.match, sideOf(seat), content.rules.hiddenLoadouts);
  const names = new Map(categoriesOf(content, locale).map((c) => [c.id, c]));
  const named = (c: Category) => names.get(c.id) ?? c;
  const m = seen.state;
  const match: MatchState = {
    ...m,
    categoryPool: [],
    categories: { player: m.categories.player.map(named), opponent: m.categories.opponent.map(named) },
    roundCategory: m.roundCategory ? named(m.roundCategory) : null,
    // Question ids stay on the server: the questions API answers by id.
    usedQuestionIds: [],
  };
  const mcq = m.mcq ? content.mcqs.find((q) => q.id === m.mcq!.question.id) : undefined;
  if (match.mcq && mcq) {
    match.mcq = {
      ...match.mcq,
      categoryName: names.get(mcq.categoryId)?.name ?? match.mcq.categoryName,
      question: { ...match.mcq.question, id: `q${match.mcq.key}`, prompt: text(mcq.prompt, locale), options: mcq.options.map((o) => text(o, locale)) },
    };
  }
  const winner = winnerOf(s);
  return {
    phase: s.phase,
    deadline: s.deadline,
    you: seat,
    rounds: MATCH_ROUNDS,
    loadoutIn: { you: !!s.loadouts[seat], them: !!s.loadouts[other(seat)] },
    match,
    opponentAnswered: seen.opponentAnswered,
    opponentGuessed: seen.opponentGuessed,
    question: match.mcq ? { prompt: match.mcq.question.prompt, options: match.mcq.question.options } : null,
    categories: categoriesOf(content, locale),
    end: s.phase === 'over' ? { winner: winner === null ? null : winner === seat ? 'you' : 'them', reason: s.end?.reason ?? 'score' } : null,
  };
}
