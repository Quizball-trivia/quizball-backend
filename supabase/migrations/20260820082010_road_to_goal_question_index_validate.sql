DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index index_row
    WHERE index_row.indexrelid = pg_catalog.to_regclass(
      'public.idx_questions_road_to_goal_eligible'
    )
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indrelid = pg_catalog.to_regclass('public.questions')
      AND index_row.indnkeyatts = 2
      AND (
        SELECT array_agg(attribute.attname::text ORDER BY key_column.ordinality)
        FROM unnest(index_row.indkey::smallint[]) WITH ORDINALITY
          AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality <= index_row.indnkeyatts
      ) = ARRAY['difficulty', 'id']::text[]
      AND pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid) =
        '((status = ''published''::text) AND (type = ''mcq_single''::text) AND (ranked_eligible = true) AND (visibility = ''public''::text))'
  ) THEN
    RAISE EXCEPTION 'Road to Goal eligible-question index definition is missing or invalid';
  END IF;
END;
$$;
