-- Rename the Georgian TRUE answer label on true/false questions:
-- "ჭეშმარიტია" → "მართალია" (pairs with the existing "მცდარია" FALSE label).
--
-- question_payloads.payload is stored either as a jsonb string (current data)
-- or a jsonb object — handle both forms.

-- String-form payloads (payload is a jsonb string containing JSON text).
UPDATE public.question_payloads qp
SET payload = to_jsonb(replace(qp.payload #>> '{}', '"ka":"ჭეშმარიტია"', '"ka":"მართალია"'))
FROM public.questions q
WHERE q.id = qp.question_id
  AND q.type = 'true_false'
  AND jsonb_typeof(qp.payload) = 'string'
  AND (qp.payload #>> '{}') LIKE '%"ka":"ჭეშმარიტია"%';

-- Object-form payloads (defensive — none on staging today).
UPDATE public.question_payloads qp
SET payload = (replace(qp.payload::text, '"ka": "ჭეშმარიტია"', '"ka": "მართალია"')
               )::jsonb
FROM public.questions q
WHERE q.id = qp.question_id
  AND q.type = 'true_false'
  AND jsonb_typeof(qp.payload) = 'object'
  AND qp.payload::text LIKE '%"ka": "ჭეშმარიტია"%';
