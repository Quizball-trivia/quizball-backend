-- Structured avatar customization must be a JSON object or SQL NULL.
-- Clear JSON string values created by an earlier unsafe identity insert path.
UPDATE public.users
SET avatar_customization = NULL
WHERE jsonb_typeof(avatar_customization) = 'string';
