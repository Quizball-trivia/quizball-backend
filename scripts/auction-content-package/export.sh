#!/usr/bin/env bash
# Auction content package EXPORT (run against STAGING).
#
# Produces a deterministic, checksummed set of CSVs holding exactly the
# content the auction runtime reads: the 1,311 players with published clue
# cards, their market-value history, the published bilingual clue cards, and
# their season snapshots. Operational tables (seen cards, scout encounters,
# AP, matches) are deliberately NOT exported — they start empty on prod.
#
# Usage: STAGING_DB="host=... port=5432 user=postgres.<ref> dbname=postgres sslmode=require" \
#        PGPASSWORD=... ./export.sh <output-dir>
set -euo pipefail
OUT="${1:?output dir required}"
mkdir -p "$OUT"

PLAYERS_SUBQ="SELECT DISTINCT football_player_id FROM player_clue_cards WHERE status='published'"

copy() {
  local name="$1" query="$2"
  psql "$STAGING_DB" -v ON_ERROR_STOP=1 -q -c "\\copy ($query) TO '$OUT/$name.csv' WITH (FORMAT csv, HEADER)"
  echo "exported $name: $(( $(wc -l < "$OUT/$name.csv") - 1 )) rows"
}

# Pipeline-provenance FKs (content_snapshots / card_generation_tasks) are
# NULLed: those tables deliberately start EMPTY on prod — they are staging
# pipeline history, not gameplay content — and carrying the ids would break
# the FKs at import. Column lists are built from the live schema so the CSVs
# always match the target table shape.
cols() { # cols <table> <comma-separated columns to NULL out>
  psql "$STAGING_DB" -v ON_ERROR_STOP=1 -t -A -c "
    SELECT string_agg(
      CASE WHEN column_name = ANY(string_to_array('$2', ',')) THEN 'NULL::uuid AS '||column_name
           ELSE column_name END, ', ' ORDER BY ordinal_position)
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='$1'"
}

copy football_players "SELECT $(cols football_players last_seen_snapshot_id) FROM football_players WHERE id IN ($PLAYERS_SUBQ) ORDER BY id"
copy football_player_market_values "SELECT $(cols football_player_market_values snapshot_id) FROM football_player_market_values WHERE football_player_id IN ($PLAYERS_SUBQ) ORDER BY football_player_id, valuation_date, source"
copy player_clue_cards "SELECT $(cols player_clue_cards snapshot_id,generation_task_id) FROM player_clue_cards WHERE status='published' ORDER BY id"
copy player_season_snapshots "SELECT * FROM player_season_snapshots WHERE football_player_id IN ($PLAYERS_SUBQ) ORDER BY football_player_id, season_label, id"

# Expected-state manifest: counts + the runtime pool table computed with the
# EXACT eligibility predicate from auction-content.repo.ts. The importer
# re-runs the same queries against prod and must reproduce every number.
psql "$STAGING_DB" -v ON_ERROR_STOP=1 -q -t -A -F'|' -c "
SELECT 'players', count(*) FROM football_players WHERE id IN ($PLAYERS_SUBQ)
UNION ALL SELECT 'market_values', count(*) FROM football_player_market_values WHERE football_player_id IN ($PLAYERS_SUBQ)
UNION ALL SELECT 'cards_published', count(*) FROM player_clue_cards WHERE status='published'
UNION ALL SELECT 'cards_en', count(*) FROM player_clue_cards WHERE status='published' AND locale='en'
UNION ALL SELECT 'cards_ka', count(*) FROM player_clue_cards WHERE status='published' AND locale='ka'
UNION ALL SELECT 'players_missing_a_locale', count(*) FROM (
  SELECT football_player_id FROM player_clue_cards WHERE status='published'
  GROUP BY football_player_id HAVING count(DISTINCT locale) < 2) x
UNION ALL SELECT 'snapshots', count(*) FROM player_season_snapshots WHERE football_player_id IN ($PLAYERS_SUBQ)
UNION ALL
SELECT 'pool_'||position_group, count(*) FROM player_clue_card_content_view
WHERE locale='en' AND status='published' AND active_status='active' AND image_url IS NOT NULL
  AND current_value_eur IS NOT NULL AND position_group IN ('GK','DEF','MID','FWD')
  AND auction_price_eur IS NOT NULL AND starting_price_eur IS NOT NULL
  AND football_player_id IN (SELECT football_player_id FROM player_season_snapshots
    WHERE value_eur IS NOT NULL GROUP BY football_player_id HAVING count(*) >= 3)
GROUP BY position_group
" > "$OUT/expected-counts.txt"

( cd "$OUT" && shasum -a 256 ./*.csv > checksums.sha256 )
echo "--- expected-counts:"; cat "$OUT/expected-counts.txt"
echo "--- checksums:"; cat "$OUT/checksums.sha256"
