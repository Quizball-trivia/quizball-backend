import type { I18nField } from '../../db/types.js';

/**
 * Free Kicks answer timing — scales with how much there is to read.
 *
 * Short questions keep the ranked MCQ timing (10s visible timer). Long ones get
 * extra reading time so the player is tested on knowledge, not reading speed:
 * +1s per READ_CHARS_PER_SECOND characters beyond the free allowance, capped.
 *
 * The length is the LONGEST locale's prompt + options, so every player gets at
 * least the time their own language needs (and the server deadline is identical
 * for everyone). The result is never below the base, so the server is never
 * stricter than the original fixed window.
 */

/** Visible answer timer for a short question (ranked MCQ timing). */
export const BASE_ANSWER_MS = 10_000;
/** Ceiling for the visible answer timer, however long the question is. */
export const MAX_ANSWER_MS = 20_000;
/** Prompt + options characters the base timer already covers. */
export const FREE_READ_CHARS = 90;
/** Reading speed used for the extra allowance (characters per added second). */
export const READ_CHARS_PER_SECOND = 12;

/**
 * Fixed overhead around the visible timer on the server deadline:
 * 2s answer reveal (the next question is dealt inside the answer response)
 * + 3s reading pause before options show + 2.5s network grace.
 */
export const QUESTION_WINDOW_OVERHEAD_MS = 7_500;

function textLength(value: unknown): number {
  return typeof value === 'string' ? value.trim().length : 0;
}

/** Characters the player must read in the longest locale (prompt + every option). */
export function questionReadChars(prompt: I18nField, options: ReadonlyArray<{ text: I18nField }>): number {
  const locales = new Set<string>([
    ...Object.keys(prompt ?? {}),
    ...options.flatMap((option) => Object.keys(option.text ?? {})),
  ]);
  let longest = 0;
  for (const locale of locales) {
    const total = textLength(prompt?.[locale])
      + options.reduce((sum, option) => sum + textLength(option.text?.[locale]), 0);
    longest = Math.max(longest, total);
  }
  return longest;
}

/** Visible answer time in ms for a given amount of text. */
export function answerTimeMsForChars(chars: number): number {
  const extraChars = Math.max(0, chars - FREE_READ_CHARS);
  const extraMs = Math.ceil(extraChars / READ_CHARS_PER_SECOND) * 1000;
  return Math.min(MAX_ANSWER_MS, BASE_ANSWER_MS + extraMs);
}

export function answerTimeMsForQuestion(
  prompt: I18nField,
  options: ReadonlyArray<{ text: I18nField }>
): number {
  return answerTimeMsForChars(questionReadChars(prompt, options));
}

/** Server-side deadline window for a question with the given visible answer time. */
export function questionWindowMs(answerTimeMs: number): number {
  return QUESTION_WINDOW_OVERHEAD_MS + Math.max(BASE_ANSWER_MS, answerTimeMs);
}
