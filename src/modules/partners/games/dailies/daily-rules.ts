/** The five Freecroco dailies (contract §7 + §7.2): how an item is built from a bank question, what the browser may see
 *  of it, how an answer is judged and what it is worth. Everything here is pure; daily-play.service.ts owns state. */

import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../../../core/config.js';
import type { Json } from '../../../../db/types.js';
import { getLocalizedString, mergeLocalizedAcceptedAnswers } from '../../../../lib/localization.js';
import { questionPayloadSchema, type QuestionPayload } from '../../../questions/questions.schemas.js';
import {
  countdownMatch,
  countdownMatchV2,
  fuzzyMatchesAnswer,
  fuzzyMatchesAnswerV2,
} from '../../../../realtime/possession-answer-matching.js';

export const PARTNER_DAILY_GAME_IDS = ['countdown', 'true-false', 'pick-em', 'career-path', 'higher-lower'] as const;
export type PartnerDailyGameId = (typeof PARTNER_DAILY_GAME_IDS)[number];

/** Localized text as stored in the snapshot ({ en, ka, … }). */
export type Text = Record<string, string>;

export interface BankRow {
  id: string;
  prompt: Json | null;
  payload: Json;
  category_name: Json;
}

export type EndCause = 'answered' | 'timeout' | 'skipped';

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface BaseState {
  resolved: boolean;
  cause?: EndCause;
}

export interface DailyRules<I extends { qid: string }, S extends BaseState, In> {
  gameId: PartnerDailyGameId;
  questionType: QuestionPayload['type'];
  itemCount: number;
  secondsPerItem: number;
  /** Null when the question cannot be played in this game. */
  snapshot(row: BankRow): I | null;
  /** Keys that make two items "the same answer" (never two in one play). */
  answerKeys(item: I): string[];
  initialState(item: I): S;
  /** What the browser may see of an open item: never an answer. */
  view(item: I, state: S, locale: string): unknown;
  input: z.ZodType<In>;
  /** Judges one answer; sets `resolved` when the item is over. `foundInPlay` = countdown answers found so far. */
  answer(item: I, state: S, input: In, ctx: { foundInPlay: number; locale: string }): { state: S; feedback: unknown };
  /** Ends an open item without (more) answers. */
  close(item: I, state: S, cause: EndCause): S;
  /** Shown only once the item is resolved. */
  reveal(item: I, state: S, locale: string): unknown;
  points(item: I, state: S): number;
}

// --- helpers ------------------------------------------------------------------------------------------------------

export function localize(value: Text | null | undefined, locale: string, fallback = ''): string {
  if (!value) return fallback;
  const text = getLocalizedString(value as Json, { preferredLocales: locale === 'en' ? ['en'] : [locale, 'en'], fallback }).trim();
  return text || fallback;
}

/** Any stored localized value (object, JSON-in-a-string or a plain string) as { locale: text }. */
function toText(value: unknown): Text | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        return toText(JSON.parse(trimmed));
      } catch {
        // a plain prompt that happens to start with a brace
      }
    }
    return trimmed ? { en: trimmed } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Text = {};
  for (const [key, text] of Object.entries(value)) {
    if (typeof text === 'string' && text.trim()) out[key] = text.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

function promptOf(row: BankRow): Text | null {
  const direct = toText(row.prompt);
  if (direct) return direct;
  const payload = row.payload as Record<string, unknown> | null;
  return toText(payload?.prompt ?? payload?.question ?? payload?.title ?? payload?.stem);
}

function payloadOf<T extends QuestionPayload['type']>(row: BankRow, type: T): Extract<QuestionPayload, { type: T }> | null {
  const parsed = questionPayloadSchema.safeParse(row.payload);
  return parsed.success && parsed.data.type === type ? (parsed.data as Extract<QuestionPayload, { type: T }>) : null;
}

function normalizeKey(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
}

function textKeys(value: Text): string[] {
  return Object.values(value).map(normalizeKey).filter(Boolean);
}

const matcherV2 = () => config.ANSWER_MATCHER_V2 === 'on';

const nullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable();

// --- True / False: 4 × 15 s, 50 per correct -----------------------------------------------------------------------

interface TrueFalseItem {
  qid: string;
  category: Text | null;
  prompt: Text;
  trueLabel: Text;
  falseLabel: Text;
  answer: boolean;
}
interface ChoiceState<T> extends BaseState {
  picked?: T | null;
  correct?: boolean;
}

export const trueFalseRules: DailyRules<TrueFalseItem, ChoiceState<boolean>, { answer: boolean | null }> = {
  gameId: 'true-false',
  questionType: 'true_false',
  itemCount: 4,
  secondsPerItem: 15,
  snapshot(row) {
    const payload = payloadOf(row, 'true_false');
    const prompt = promptOf(row);
    if (!payload || !prompt) return null;
    return {
      qid: row.id,
      category: toText(row.category_name),
      prompt,
      trueLabel: toText(payload.options[0].text) ?? { en: 'True' },
      falseLabel: toText(payload.options[1].text) ?? { en: 'False' },
      // Option 0 is the "true" option: the statement is true exactly when it is the correct one.
      answer: payload.options[0].is_correct,
    };
  },
  answerKeys: () => [],
  initialState: () => ({ resolved: false }),
  view: (item, _state, locale) => ({
    category: localize(item.category, locale),
    prompt: localize(item.prompt, locale),
    trueLabel: localize(item.trueLabel, locale, 'True'),
    falseLabel: localize(item.falseLabel, locale, 'False'),
  }),
  input: z.object({ answer: nullable(z.boolean()) }),
  answer(item, _state, input) {
    if (input.answer === null) return { state: this.close(item, _state, 'skipped'), feedback: { correct: false } };
    const correct = input.answer === item.answer;
    return { state: { resolved: true, cause: 'answered', picked: input.answer, correct }, feedback: { correct } };
  },
  close: (_item, state, cause) => ({ ...state, resolved: true, cause, correct: false }),
  reveal: (item, state) => ({ correctAnswer: item.answer, picked: state.picked ?? null, correct: state.correct === true }),
  points: (_item, state) => (state.correct ? 50 : 0),
};

// --- Pick Em ("imposter"): 2 × 30 s, 250 per fully correct selection --------------------------------------------

interface PickEmItem {
  qid: string;
  category: Text | null;
  prompt: Text;
  options: Array<{ id: string; text: Text; correct: boolean }>;
}

export const pickEmRules: DailyRules<PickEmItem, ChoiceState<string[]>, { optionIds: string[] | null }> = {
  gameId: 'pick-em',
  questionType: 'imposter_multi_select',
  itemCount: 2,
  secondsPerItem: 30,
  snapshot(row) {
    const payload = payloadOf(row, 'imposter_multi_select');
    const prompt = promptOf(row);
    if (!payload || !prompt) return null;
    // Content is authored with the correct options first; the stored order is what the browser shows.
    const options = shuffled(payload.options.map((o) => ({ id: o.id, text: toText(o.text) ?? { en: o.id }, correct: o.is_correct })));
    if (new Set(options.map((o) => o.id)).size !== options.length) return null;
    return { qid: row.id, category: toText(row.category_name), prompt, options };
  },
  answerKeys: () => [],
  initialState: () => ({ resolved: false }),
  view: (item, _state, locale) => ({
    category: localize(item.category, locale),
    prompt: localize(item.prompt, locale),
    options: item.options.map((o) => ({ id: o.id, text: localize(o.text, locale) })),
  }),
  input: z.object({ optionIds: nullable(z.array(z.string().min(1).max(100)).max(12)) }),
  answer(item, state, input) {
    if (input.optionIds === null) return { state: this.close(item, state, 'skipped'), feedback: { correct: false } };
    const picked = [...new Set(input.optionIds)].sort();
    const wanted = item.options.filter((o) => o.correct).map((o) => o.id).sort();
    // The submitted set itself must be the right one: an id that is not an option makes it wrong.
    const correct = picked.length === wanted.length && picked.every((id, i) => id === wanted[i]);
    return { state: { resolved: true, cause: 'answered', picked, correct }, feedback: { correct } };
  },
  close: (_item, state, cause) => ({ ...state, resolved: true, cause, correct: false }),
  reveal: (item, state) => ({
    correctOptionIds: item.options.filter((o) => o.correct).map((o) => o.id),
    picked: state.picked ?? [],
    correct: state.correct === true,
  }),
  points: (_item, state) => (state.correct ? 250 : 0),
};

// --- Career Path: 3 × 30 s, 100 per player guessed (one guess, server fuzzy match) ----------------------------------

interface CareerPathItem {
  qid: string;
  category: Text | null;
  clubs: Text[];
  displayAnswer: Text;
  accepted: string[];
}

export const careerPathRules: DailyRules<CareerPathItem, ChoiceState<string>, { guess: string | null }> = {
  gameId: 'career-path',
  questionType: 'career_path',
  itemCount: 3,
  secondsPerItem: 30,
  snapshot(row) {
    const payload = payloadOf(row, 'career_path');
    const displayAnswer = payload ? toText(payload.display_answer) : null;
    if (!payload || !displayAnswer) return null;
    const clubs = payload.clubs.map((club) => toText(club)).filter((club): club is Text => club !== null);
    if (clubs.length < 2) return null;
    return {
      qid: row.id,
      category: toText(row.category_name),
      clubs,
      displayAnswer,
      accepted: mergeLocalizedAcceptedAnswers(payload.accepted_answers, payload.display_answer as Json),
    };
  },
  answerKeys: (item) => textKeys(item.displayAnswer),
  initialState: () => ({ resolved: false }),
  view: (item, _state, locale) => ({
    category: localize(item.category, locale),
    clubs: item.clubs.map((club) => localize(club, locale, 'Club')),
    // English names find the crests whatever the language.
    clubMatchNames: item.clubs.map((club) => localize(club, 'en', 'Club')),
  }),
  input: z.object({ guess: nullable(z.string().max(120)) }),
  answer(item, state, input) {
    const guess = input.guess?.trim() ?? '';
    if (!guess) return { state: this.close(item, state, 'skipped'), feedback: { correct: false } };
    const correct = (matcherV2() ? fuzzyMatchesAnswerV2 : fuzzyMatchesAnswer)(guess, item.accepted);
    return { state: { resolved: true, cause: 'answered', picked: guess, correct }, feedback: { correct } };
  },
  close: (_item, state, cause) => ({ ...state, resolved: true, cause, correct: false }),
  reveal: (item, state, locale) => ({ displayAnswer: localize(item.displayAnswer, locale), correct: state.correct === true }),
  points: (_item, state) => (state.correct ? 100 : 0),
};

// --- Higher / Lower: 2 rounds × 30 s, 200 per round cleared without a mistake ----------------------------------------

interface Side {
  name: Text;
  value: number;
}
interface HigherLowerItem {
  qid: string;
  category: Text | null;
  prompt: Text | null;
  statLabel: Text;
  /** Sides already shuffled when the play was drawn, so the browser's left/right is the stored one. */
  matchups: Array<{ id: string; left: Side; right: Side }>;
}
interface HigherLowerState extends BaseState {
  matchupIndex: number;
  picks: Array<{ matchupId: string; pick: 'left' | 'right'; correct: boolean }>;
  cleared?: boolean;
}

export const higherLowerRules: DailyRules<HigherLowerItem, HigherLowerState, { matchupIndex: number; pick: 'left' | 'right' | null }> = {
  gameId: 'higher-lower',
  questionType: 'high_low',
  itemCount: 2,
  secondsPerItem: 30,
  snapshot(row) {
    const payload = payloadOf(row, 'high_low');
    const statLabel = payload ? toText(payload.stat_label) : null;
    if (!payload || !statLabel) return null;
    const matchups = payload.matchups.map((m) => {
      const a = { name: toText(m.left_name) ?? { en: 'Left' }, value: m.left_value };
      const b = { name: toText(m.right_name) ?? { en: 'Right' }, value: m.right_value };
      return Math.random() < 0.5 ? { id: m.id, left: a, right: b } : { id: m.id, left: b, right: a };
    });
    return { qid: row.id, category: toText(row.category_name), prompt: promptOf(row), statLabel, matchups };
  },
  answerKeys: () => [],
  initialState: () => ({ resolved: false, matchupIndex: 0, picks: [] }),
  view(item, state, locale) {
    const matchup = item.matchups[Math.min(state.matchupIndex, item.matchups.length - 1)];
    return {
      category: localize(item.category, locale),
      statLabel: localize(item.statLabel, locale),
      prompt: item.prompt ? localize(item.prompt, locale) : localize(item.statLabel, locale),
      matchupIndex: state.matchupIndex,
      matchupCount: item.matchups.length,
      left: localize(matchup.left.name, locale),
      right: localize(matchup.right.name, locale),
      // Values of matchups already passed: the player has seen them revealed.
      passed: state.picks.map((p) => {
        const m = item.matchups.find((x) => x.id === p.matchupId)!;
        return { leftValue: m.left.value, rightValue: m.right.value, pick: p.pick, correct: p.correct };
      }),
    };
  },
  input: z.object({ matchupIndex: z.number().int().min(0).max(100), pick: nullable(z.enum(['left', 'right'])) }),
  answer(item, state, input) {
    if (input.pick === null) return { state: this.close(item, state, 'skipped'), feedback: null };
    // A repeated or out-of-order pick (retry, double tap) changes nothing.
    if (input.matchupIndex !== state.matchupIndex) return { state, feedback: null };
    const matchup = item.matchups[state.matchupIndex];
    const [picked, other] = input.pick === 'left' ? [matchup.left, matchup.right] : [matchup.right, matchup.left];
    const correct = picked.value >= other.value;
    const picks = [...state.picks, { matchupId: matchup.id, pick: input.pick, correct }];
    const last = state.matchupIndex >= item.matchups.length - 1;
    const feedback = { correct, leftValue: matchup.left.value, rightValue: matchup.right.value };
    if (!correct) return { state: { ...state, picks, resolved: true, cause: 'answered', cleared: false }, feedback };
    if (last) return { state: { ...state, picks, resolved: true, cause: 'answered', cleared: true }, feedback };
    return { state: { ...state, picks, matchupIndex: state.matchupIndex + 1 }, feedback };
  },
  close: (_item, state, cause) => ({ ...state, resolved: true, cause, cleared: false }),
  reveal: (_item, state) => ({ cleared: state.cleared === true, matchupsPassed: state.picks.filter((p) => p.correct).length }),
  points: (_item, state) => (state.cleared ? 200 : 0),
};

// --- Countdown: 2 rounds × 30 s, 50 per distinct answer group found, at most 50 answers a play ----------------------

export const COUNTDOWN_MAX_ANSWERS_PER_PLAY = 50;
/** Above what 30 seconds of typing produces, low enough that spraying short guesses does not pay. */
export const COUNTDOWN_MAX_GUESSES_PER_ROUND = 40;
/** A partial or misspelt name counts only from 5 letters, so blind short guesses cannot claim answers; an exact short
 *  name still counts. */
export const COUNTDOWN_MIN_PARTIAL_LENGTH = 5;

interface CountdownItem {
  qid: string;
  category: Text | null;
  prompt: Text;
  groups: Array<{ id: string; display: Text; accepted: string[] }>;
}
interface CountdownState extends BaseState {
  found: string[];
  guesses: number;
}

export const countdownRules: DailyRules<CountdownItem, CountdownState, { guess: string | null }> = {
  gameId: 'countdown',
  questionType: 'countdown_list',
  itemCount: 2,
  secondsPerItem: 30,
  snapshot(row) {
    const payload = payloadOf(row, 'countdown_list');
    const prompt = payload ? toText(payload.prompt) : null;
    if (!payload || !prompt) return null;
    const groups = payload.answer_groups.map((g) => ({
      id: g.id,
      display: toText(g.display) ?? { en: g.id },
      accepted: mergeLocalizedAcceptedAnswers(g.accepted_answers, g.display as Json),
    }));
    if (new Set(groups.map((g) => g.id)).size !== groups.length) return null;
    return { qid: row.id, category: toText(row.category_name), prompt, groups };
  },
  answerKeys: () => [],
  initialState: () => ({ resolved: false, found: [], guesses: 0 }),
  view: (item, state, locale) => ({
    category: localize(item.category, locale),
    prompt: localize(item.prompt, locale),
    // Found answers are the player's own: shown back so a reload keeps the list.
    found: state.found.map((id) => localize(item.groups.find((g) => g.id === id)?.display, locale)),
  }),
  input: z.object({ guess: nullable(z.string().max(80)) }),
  answer(item, state, input, ctx) {
    const guess = input.guess?.trim() ?? '';
    if (!guess) return { state, feedback: { accepted: false } };
    if (state.guesses >= COUNTDOWN_MAX_GUESSES_PER_ROUND) return { state, feedback: { accepted: false, limited: true } };
    const next = { ...state, guesses: state.guesses + 1 };
    if (ctx.foundInPlay >= COUNTDOWN_MAX_ANSWERS_PER_PLAY) return { state: next, feedback: { accepted: false, capped: true } };
    const evaluation = {
      kind: 'countdown' as const,
      answerGroups: item.groups.map((g) => ({ id: g.id, display: g.display, acceptedAnswers: g.accepted })),
    };
    // The guess's strongest match is resolved as if nothing were found yet: repeating an answer already found must
    // not fall through to a weaker (typo or prefix) match in another group.
    const match = (matcherV2() ? countdownMatchV2 : countdownMatch)(evaluation, guess, new Set(), {
      minPrefixLength: COUNTDOWN_MIN_PARTIAL_LENGTH,
      minTypoLength: COUNTDOWN_MIN_PARTIAL_LENGTH,
    });
    if (!match || state.found.includes(match.id)) return { state: next, feedback: { accepted: false } };
    return {
      state: { ...next, found: [...state.found, match.id] },
      feedback: { accepted: true, display: localize(match.display, ctx.locale) },
    };
  },
  close: (_item, state, cause) => ({ ...state, resolved: true, cause }),
  reveal: (item, state, locale) => ({
    found: state.found.map((id) => localize(item.groups.find((g) => g.id === id)?.display, locale)),
  }),
  points: (_item, state) => state.found.length * 50,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDailyRules = DailyRules<any, any, any>;

export const PARTNER_DAILY_RULES: Record<PartnerDailyGameId, AnyDailyRules> = {
  countdown: countdownRules,
  'true-false': trueFalseRules,
  'pick-em': pickEmRules,
  'career-path': careerPathRules,
  'higher-lower': higherLowerRules,
};

export function isPartnerDailyGameId(value: string): value is PartnerDailyGameId {
  return (PARTNER_DAILY_GAME_IDS as readonly string[]).includes(value);
}
