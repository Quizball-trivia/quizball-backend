DO $$
DECLARE
  ledger_index_ready boolean;
BEGIN
  SELECT index_row.indisvalid AND index_row.indisready
  INTO ledger_index_ready
  FROM pg_catalog.pg_index index_row
  WHERE index_row.indexrelid = pg_catalog.to_regclass(
    'public.uq_store_tx_road_to_goal_idempotency'
  );

  IF ledger_index_ready IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Road to Goal ledger idempotency index is missing or invalid';
  END IF;
END;
$$;

