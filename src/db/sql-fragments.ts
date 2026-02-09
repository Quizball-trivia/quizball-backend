import { sql } from './index.js';

/**
 * SQL conditions that validate a question + payload row pair
 * represents a well-formed MCQ with exactly 4 options, 1 correct answer,
 * and valid UUIDs. Assumes `q` aliases `questions` and `qp` aliases `question_payloads`.
 */
export const MCQ_VALIDATION_CONDITIONS = sql`
  q.status = 'published'
  AND q.type = 'mcq_single'
  AND qp.payload ? 'options'
  AND jsonb_typeof(qp.payload->'options') = 'array'
  AND jsonb_array_length(qp.payload->'options') = 4
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(qp.payload->'options') opt
    WHERE jsonb_typeof(opt) <> 'object'
       OR NOT (opt ? 'id')
       OR jsonb_typeof(opt->'id') <> 'string'
       OR (opt->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR NOT (opt ? 'text')
       OR jsonb_typeof(opt->'text') <> 'object'
       OR NOT (opt ? 'is_correct')
       OR (opt->>'is_correct') NOT IN ('true', 'false')
  )
  AND (
    SELECT COUNT(*)
    FROM jsonb_array_elements(qp.payload->'options') opt
    WHERE opt->>'is_correct' = 'true'
  ) = 1
  AND (
    SELECT COUNT(DISTINCT opt->>'id')
    FROM jsonb_array_elements(qp.payload->'options') opt
  ) = 4
`;
