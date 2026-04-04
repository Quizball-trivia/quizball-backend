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

// ── Raw string version for use with sql.unsafe() ──
// Single source of truth: derived from the same logic as MCQ_VALIDATION_CONDITIONS above.

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

const NORMALIZED_MCQ_OPTIONS_RAW = `(${NORMALIZED_MCQ_PAYLOAD_RAW}->'options')`;

/**
 * Raw SQL string for JSONB MCQ validation, for use with sql.unsafe().
 * Validates published mcq_single questions with well-formed payloads.
 * Assumes `q` aliases `questions` and `qp` aliases `question_payloads`.
 * Includes leading AND — callers should append directly to a WHERE clause.
 */
export const VALID_PAYLOAD_CONDITIONS_RAW = `
  AND (${NORMALIZED_MCQ_PAYLOAD_RAW}) ? 'options'
  AND jsonb_typeof(${NORMALIZED_MCQ_OPTIONS_RAW}) = 'array'
  AND jsonb_array_length(${NORMALIZED_MCQ_OPTIONS_RAW}) = 4
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(${NORMALIZED_MCQ_OPTIONS_RAW}) opt
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
    FROM jsonb_array_elements(${NORMALIZED_MCQ_OPTIONS_RAW}) opt
    WHERE opt->>'is_correct' = 'true'
  ) = 1
  AND (
    SELECT COUNT(DISTINCT opt->>'id')
    FROM jsonb_array_elements(${NORMALIZED_MCQ_OPTIONS_RAW}) opt
  ) = 4
`;
