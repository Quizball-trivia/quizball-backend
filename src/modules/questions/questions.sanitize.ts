/**
 * Player-facing question sanitizer.
 *
 * Question payloads carry their own answer keys (options[].is_correct,
 * accepted_answers, sort_value, high/low values, explanations). The CMS needs
 * them; players must NEVER receive them — any authenticated user could
 * otherwise bulk-download the full answer key and trivially beat every quiz
 * surface, including real-money modes.
 *
 * The sanitizer deep-strips every answer-bearing key from a response object.
 * Solo-game clients verify answers via POST /questions/:id/check instead.
 */

/** Keys that reveal (or strongly hint) the correct answer. */
const ANSWER_KEYS = new Set([
  'is_correct',
  'accepted_answers',
  'display_answer',
  'answer_groups',
  'sort_value',
  'left_value',
  'right_value',
  'explanation',
]);

function deepStrip(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepStrip);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (ANSWER_KEYS.has(key)) continue;
      out[key] = deepStrip(inner);
    }
    return out;
  }
  return value;
}

/**
 * Strip answer-bearing fields from an API question response (the mapper
 * output, i.e. after payload JSON parsing). Returns a new object.
 */
export function sanitizeQuestionResponse<T extends { payload?: unknown }>(response: T): T {
  if (response == null || typeof response !== 'object') return response;
  const clone = { ...response } as T & { payload?: unknown; explanation?: unknown };
  if (clone.payload != null) clone.payload = deepStrip(clone.payload);
  if ('explanation' in clone) delete clone.explanation;
  return clone;
}
