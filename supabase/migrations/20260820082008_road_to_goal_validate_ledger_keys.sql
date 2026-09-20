DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index index_row
    WHERE index_row.indexrelid = pg_catalog.to_regclass(
      'public.road_to_goal_ledger_keys_pkey'
    )
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
  ) THEN
    RAISE EXCEPTION 'Road to Goal ledger idempotency primary key is missing or invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index index_row
    WHERE index_row.indexrelid = pg_catalog.to_regclass(
      'public.road_to_goal_ledger_keys_round_id_event_type_key'
    )
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
  ) THEN
    RAISE EXCEPTION 'Road to Goal round/event idempotency key is missing or invalid';
  END IF;
END;
$$;
