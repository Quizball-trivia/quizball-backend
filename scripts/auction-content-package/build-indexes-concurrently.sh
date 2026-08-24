#!/usr/bin/env bash
# PROD-ONLY companion to the two auction index migrations.
#
# The migration runner cannot build indexes CONCURRENTLY (its advisory-lock
# session self-deadlocks the build), and a plain build inside the runner would
# hold a SHARE lock on users/matches for the whole heap scan — blocking live
# gameplay writes. So on prod the two index migrations are pre-seeded into the
# ledger (runner skips them) and the indexes are built here, CONCURRENTLY, in
# a plain psql session that holds no other transaction: zero write-blocking.
#
# Fresh/empty environments skip this script — there the migration files build
# the same indexes on tiny tables instantly.
#
# Usage:
#   PROD_DB="host=... port=5432 user=postgres.<ref> dbname=postgres sslmode=require" \
#   PGPASSWORD=... ./build-indexes-concurrently.sh pre-seed   # BEFORE merging the backend PR
#   PGPASSWORD=... ./build-indexes-concurrently.sh build      # AFTER the deploy's migrations finish
set -euo pipefail
MODE="${1:?mode required: pre-seed | build}"

if [ "$MODE" = "pre-seed" ]; then
  psql "$PROD_DB" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES
  ('20260727130001', 'auction_points_index'),
  ('20260820073707', 'football_grid_concurrent_indexes')
ON CONFLICT (version) DO NOTHING;
SQL
  echo "ledger pre-seeded: runner will skip both index migrations"
  exit 0
fi

if [ "$MODE" = "build" ]; then
  psql "$PROD_DB" -v ON_ERROR_STOP=1 -c \
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_auction_points_desc
       ON public.users (auction_points DESC, updated_at ASC)
       WHERE auction_points > 0;"
  psql "$PROD_DB" -v ON_ERROR_STOP=1 -c \
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS matches_active_game_variant_idx
       ON public.matches (game_variant, updated_at DESC)
       WHERE status = 'active';"
  psql "$PROD_DB" -v ON_ERROR_STOP=1 -t -c \
    "SELECT indexrelid::regclass || ' valid=' || indisvalid
       FROM pg_index
      WHERE indexrelid::regclass::text IN
        ('idx_users_auction_points_desc', 'matches_active_game_variant_idx');" \
    | tee /dev/stderr | grep -q "valid=f" && { echo "INVALID INDEX — drop and rebuild" >&2; exit 1; }
  echo "both indexes built concurrently and valid"
  exit 0
fi

echo "unknown mode: $MODE" >&2
exit 1
