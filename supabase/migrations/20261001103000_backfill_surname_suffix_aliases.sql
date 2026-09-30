-- The alias generator only ever emitted the LAST name token as a family_name
-- alias (English only), so compound surnames ("Funes Mori", "van Dijk") and
-- Georgian surnames exist nowhere, and surname coverage varies by release —
-- the typeahead cannot suggest them even though the resolvers now accept them
-- at runtime. The generator is fixed in this change; this migration backfills
-- existing releases by deriving every token suffix from the ALREADY-NORMALISED
-- full-name aliases (en full_name / ka georgian), so no normalisation is
-- re-implemented in SQL. Additive and idempotent: NOT EXISTS skips any
-- (release, player, normalized form, locale) that already has a row.

WITH full_names AS (
  SELECT DISTINCT release_id, football_player_id, normalized_alias, locale
  FROM football_grid_player_aliases
  WHERE (locale = 'en' AND alias_type = 'full_name')
     OR (locale = 'ka' AND alias_type = 'georgian')
),
tokens AS (
  SELECT release_id, football_player_id, locale,
         regexp_split_to_array(normalized_alias, ' ') AS toks
  FROM full_names
),
suffixes AS (
  SELECT DISTINCT t.release_id, t.football_player_id, t.locale,
         array_to_string(t.toks[i:], ' ') AS suffix,
         CASE WHEN i = array_length(t.toks, 1) THEN 'family_name' ELSE 'compound_surname' END AS alias_type
  FROM tokens t,
       generate_series(2, array_length(t.toks, 1)) AS i
  WHERE array_length(t.toks, 1) >= 2
)
INSERT INTO football_grid_player_aliases
  (id, release_id, football_player_id, alias, normalized_alias, locale, alias_type,
   acceptance_policy, reviewed_by, reviewed_at, created_at)
SELECT gen_random_uuid(), s.release_id, s.football_player_id, s.suffix, s.suffix, s.locale,
       s.alias_type, 'unique_only', 'surname-suffix-backfill-v1', now(), now()
FROM suffixes s
WHERE length(s.suffix) >= 2
  AND NOT EXISTS (
    SELECT 1 FROM football_grid_player_aliases e
    WHERE e.release_id = s.release_id
      AND e.football_player_id = s.football_player_id
      AND e.normalized_alias = s.suffix
      AND e.locale = s.locale
  );

-- Squad Spin's alias table is a copy of one grid release; keep it coherent the
-- same way (its resolver already matches name forms at runtime, but coherent
-- data keeps future consumers honest).
WITH full_names AS (
  SELECT DISTINCT player_id, normalized_alias, locale
  FROM squad_spin_player_aliases
  WHERE acceptance_policy = 'exact'
),
tokens AS (
  SELECT player_id, locale, regexp_split_to_array(normalized_alias, ' ') AS toks
  FROM full_names
),
suffixes AS (
  SELECT DISTINCT t.player_id, t.locale, array_to_string(t.toks[i:], ' ') AS suffix
  FROM tokens t,
       generate_series(2, array_length(t.toks, 1)) AS i
  WHERE array_length(t.toks, 1) >= 2
)
INSERT INTO squad_spin_player_aliases (player_id, normalized_alias, locale, acceptance_policy)
SELECT s.player_id, s.suffix, s.locale, 'unique_only'
FROM suffixes s
WHERE length(s.suffix) >= 2
ON CONFLICT (player_id, normalized_alias, locale) DO NOTHING;
