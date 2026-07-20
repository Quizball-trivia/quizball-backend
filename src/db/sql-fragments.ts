import { sql } from './index.js';

const NORMALIZED_MCQ_PAYLOAD = sql`
  (
    CASE
      WHEN jsonb_typeof(qp.payload) = 'object' THEN qp.payload
      WHEN jsonb_typeof(qp.payload) = 'string'
        AND (qp.payload #>> '{}') ~ '^\\s*\\{.*\\}\\s*$'
      THEN (qp.payload #>> '{}')::jsonb
      ELSE '{}'::jsonb
    END
  )
`;

const NORMALIZED_MCQ_OPTIONS = sql`(${NORMALIZED_MCQ_PAYLOAD}->'options')`;

/**
 * SQL conditions that validate a question + payload row pair
 * represents a well-formed MCQ with exactly 4 options, 1 correct answer,
 * and unique string option ids. Assumes `q` aliases `questions` and `qp` aliases `question_payloads`.
 */
export const MCQ_VALIDATION_CONDITIONS = sql`
  q.status = 'published'
  AND q.type = 'mcq_single'
  AND ${NORMALIZED_MCQ_PAYLOAD} ? 'options'
  AND jsonb_typeof(${NORMALIZED_MCQ_OPTIONS}) = 'array'
  AND jsonb_array_length(${NORMALIZED_MCQ_OPTIONS}) = 4
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(${NORMALIZED_MCQ_OPTIONS}) opt
    WHERE jsonb_typeof(opt) <> 'object'
       OR NOT (opt ? 'id')
       OR jsonb_typeof(opt->'id') <> 'string'
       OR NOT (opt ? 'text')
       OR jsonb_typeof(opt->'text') <> 'object'
       OR NOT (opt ? 'is_correct')
       OR (opt->>'is_correct') NOT IN ('true', 'false')
  )
  AND (
    SELECT COUNT(*)
    FROM jsonb_array_elements(${NORMALIZED_MCQ_OPTIONS}) opt
    WHERE opt->>'is_correct' = 'true'
  ) = 1
  AND (
    SELECT COUNT(DISTINCT opt->>'id')
    FROM jsonb_array_elements(${NORMALIZED_MCQ_OPTIONS}) opt
  ) = 4
`;

/**
 * Shared HAVING clause for ranked-eligible category queries.
 * Requires >= 4 valid MCQs plus at least 1 of each in-match special type.
 * Assumes `q` aliases `questions` and `qp` aliases `question_payloads`.
 */
export const RANKED_ELIGIBILITY_HAVING = sql`
  HAVING COUNT(*) FILTER (WHERE ${MCQ_VALIDATION_CONDITIONS}) >= 4
    AND COUNT(*) FILTER (WHERE q.type = 'put_in_order') >= 1
    AND COUNT(*) FILTER (WHERE q.type = 'clue_chain') >= 1
`;

/**
 * Cheap counts-only version of RANKED_ELIGIBILITY_HAVING — no
 * question_payloads join and no per-row JSONB validation.
 *
 * Rationale (perf, db-optimize.md #4): the JSONB MCQ validation forces
 * detoasting + parsing every published question payload, turning the
 * category-eligibility aggregates into ~850ms queries. Verified on staging
 * (2026-06-10): 0 of 4,121 published mcq_single questions fail the full
 * validation, and the counts-only rewrite returns the identical category set
 * (36/36 ranked, 38/38 friendly @ min 5) at ~7ms. Payload validity is
 * enforced at authoring time, and the per-question picker
 * (match-questions.repo, VALID_PAYLOAD_CONDITIONS) still validates payloads
 * per row — an invalid MCQ can never enter a match; at worst a borderline
 * category is overcounted here.
 * Assumes `q` aliases `questions` with status/type filtered in WHERE.
 */
export const RANKED_ELIGIBILITY_HAVING_COUNTS = sql`
  HAVING COUNT(*) FILTER (WHERE q.type = 'mcq_single') >= 4
    AND COUNT(*) FILTER (WHERE q.type = 'put_in_order') >= 1
    AND COUNT(*) FILTER (WHERE q.type = 'clue_chain') >= 1
`;

/**
 * Game-mode/daily-challenge categories must never enter matchmaking pools
 * (ranked or friendly): they hold content authored for other surfaces —
 * the daily-challenges tree (matched structurally via parent/slug so future
 * children are covered) plus standalone mode categories matched by slug.
 * Mirrors the welcome-screen exclusion list in the web app
 * (welcome.content.ts EXCLUDED_SLUGS) — keep the two in sync.
 * Assumes `c` aliases `categories`.
 */
export const MATCHMAKING_CATEGORY_EXCLUSIONS = sql`
  AND c.slug NOT LIKE 'daily-challenges%'
  AND c.slug NOT IN (
    'daily', 'daily-quiz', 'daily-challenge', 'career-path', 'career_path',
    'football-logic', 'high-low', 'high_low', 'imposter', 'jeopardy',
    'football-jeopardy', 'countdown', 'count-down', 'clues',
    'true-or-false', 'put-in-order', 'money-drop'
  )
  AND NOT EXISTS (
    SELECT 1 FROM categories pc
    WHERE pc.id = c.parent_id AND pc.slug LIKE 'daily-challenges%'
  )
`;

// ── Raw string version for use with sql.unsafe() ──
// Single source of truth: derived from the same logic as MCQ_VALIDATION_CONDITIONS above.
// Builders are parameterized on the payload expression so the per-row-once
// (LATERAL) variants below can never drift from the inline variants.

const NORMALIZED_MCQ_PAYLOAD_RAW = `
  (
    CASE
      WHEN jsonb_typeof(qp.payload) = 'object' THEN qp.payload
      WHEN jsonb_typeof(qp.payload) = 'string'
        AND (qp.payload #>> '{}') ~ '^\\s*\\{.*\\}\\s*$'
      THEN (qp.payload #>> '{}')::jsonb
      ELSE '{}'::jsonb
    END
  )
`;

function buildValidPayloadConditionsRaw(payloadExpr: string): string {
  const options = `(${payloadExpr}->'options')`;
  return `
  AND (${payloadExpr}) ? 'options'
  AND jsonb_typeof(${options}) = 'array'
  AND jsonb_array_length(${options}) = 4
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(${options}) opt
    WHERE jsonb_typeof(opt) <> 'object'
       OR NOT (opt ? 'id')
       OR jsonb_typeof(opt->'id') <> 'string'
       OR NOT (opt ? 'text')
       OR jsonb_typeof(opt->'text') <> 'object'
       OR NOT (opt ? 'is_correct')
       OR (opt->>'is_correct') NOT IN ('true', 'false')
  )
  AND (
    SELECT COUNT(*)
    FROM jsonb_array_elements(${options}) opt
    WHERE opt->>'is_correct' = 'true'
  ) = 1
  AND (
    SELECT COUNT(DISTINCT opt->>'id')
    FROM jsonb_array_elements(${options}) opt
  ) = 4
`;
}

function buildMcqHasImageConditionsRaw(payloadExpr: string): string {
  return `
  AND (${payloadExpr}) ? 'image'
  AND jsonb_typeof((${payloadExpr})->'image') = 'object'
  AND COALESCE((${payloadExpr})->'image'->>'url', '') <> ''
`;
}

/**
 * Raw SQL string for JSONB MCQ validation, for use with sql.unsafe().
 * Validates published mcq_single questions with well-formed payloads.
 * Assumes `q` aliases `questions` and `qp` aliases `question_payloads`.
 * Includes leading AND — callers should append directly to a WHERE clause.
 */
export const VALID_PAYLOAD_CONDITIONS_RAW = buildValidPayloadConditionsRaw(NORMALIZED_MCQ_PAYLOAD_RAW);

/**
 * Raw SQL string identifying an image MCQ: the normalized payload carries an
 * `image` object with a non-empty `url`. Canonical discriminator, mirrors the
 * `questions.repo.ts` list filter. Assumes `qp` aliases `question_payloads`.
 * Includes leading AND — callers append directly to a WHERE clause.
 */
export const MCQ_HAS_IMAGE_CONDITIONS_RAW = buildMcqHasImageConditionsRaw(NORMALIZED_MCQ_PAYLOAD_RAW);

// ── Per-row-once normalization (hot-path picker queries) ──
//
// Inlining NORMALIZED_MCQ_PAYLOAD_RAW into every condition makes Postgres
// re-evaluate the CASE (detoast + parse of qp.payload) for EACH reference —
// the question picker referenced it ~9× per candidate row, measured at ~45ms
// per pick on staging (brazil-world-cup, 130 MCQs). Computing it once per row
// through a LATERAL drops the pick to single-digit ms with identical
// semantics. `OFFSET 0` is the standard planner barrier that stops the
// subquery from being pulled up (which would re-inline the expression and
// undo the whole point).

/** Append after the `question_payloads qp` join. Exposes `np.p`. */
export const NORMALIZED_MCQ_PAYLOAD_LATERAL_RAW = `
  CROSS JOIN LATERAL (
    SELECT ${NORMALIZED_MCQ_PAYLOAD_RAW} AS p
    OFFSET 0
  ) np
`;

/** VALID_PAYLOAD_CONDITIONS_RAW against the lateral `np.p`. Leading AND. */
export const VALID_PAYLOAD_CONDITIONS_NP_RAW = buildValidPayloadConditionsRaw('np.p');

/** MCQ_HAS_IMAGE_CONDITIONS_RAW against the lateral `np.p`. Leading AND. */
export const MCQ_HAS_IMAGE_CONDITIONS_NP_RAW = buildMcqHasImageConditionsRaw('np.p');
