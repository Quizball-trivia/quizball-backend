#!/usr/bin/env bash
# Auction content package IMPORT (run against PROD, after the release
# migrations have been applied and the 1,311 player images copied).
#
# Single transaction: refuses to run unless every target table is EMPTY (this
# is a first-load importer, not a merge), rewrites the staging CDN host to the
# prod host in-stream, loads in FK order, then re-checks every number from
# expected-counts.txt INSIDE the transaction — any mismatch raises and the
# whole load rolls back.
#
# Usage: PROD_DB="host=... port=5432 user=postgres.<ref> dbname=postgres sslmode=require" \
#        PGPASSWORD=... ./import.sh <package-dir>
set -euo pipefail
PKG="${1:?package dir required}"
STAGING_REF="nsdfiprfmhdqhbfxfwpv"
PROD_REF="lfbwhxvwubzeqkztghok"

( cd "$PKG" && shasum -a 256 -c checksums.sha256 )

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
for f in "$PKG"/*.csv; do
  sed "s/$STAGING_REF/$PROD_REF/g" "$f" > "$WORK/$(basename "$f")"
done
LEFT=$(cat "$WORK"/*.csv | grep -c "$STAGING_REF" || true)
if [ "$LEFT" != "0" ]; then echo "staging refs remain after rewrite: $LEFT" >&2; exit 1; fi

# expected-counts.txt lines are "name|value" — build a VALUES list for the
# in-transaction assertion.
EXPECTED_VALUES=$(awk -F'|' -v q="'" 'NF==2 {printf "%s(%s%s%s::text, %s::bigint)", sep, q, $1, q, $2; sep=","}' "$PKG/expected-counts.txt")

PLAYERS_SUBQ="SELECT DISTINCT football_player_id FROM player_clue_cards WHERE status='published'"

psql "$PROD_DB" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DO \$\$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM football_players; IF n > 0 THEN RAISE EXCEPTION 'football_players not empty (%)', n; END IF;
  SELECT count(*) INTO n FROM football_player_market_values; IF n > 0 THEN RAISE EXCEPTION 'market values not empty (%)', n; END IF;
  SELECT count(*) INTO n FROM player_clue_cards; IF n > 0 THEN RAISE EXCEPTION 'player_clue_cards not empty (%)', n; END IF;
  SELECT count(*) INTO n FROM player_season_snapshots; IF n > 0 THEN RAISE EXCEPTION 'snapshots not empty (%)', n; END IF;
END \$\$;
\copy football_players FROM '$WORK/football_players.csv' WITH (FORMAT csv, HEADER)
\copy football_player_market_values FROM '$WORK/football_player_market_values.csv' WITH (FORMAT csv, HEADER)
\copy player_clue_cards FROM '$WORK/player_clue_cards.csv' WITH (FORMAT csv, HEADER)
\copy player_season_snapshots FROM '$WORK/player_season_snapshots.csv' WITH (FORMAT csv, HEADER)
DO \$\$
DECLARE bad text;
BEGIN
  WITH expected(name, value) AS (VALUES $EXPECTED_VALUES),
  actual(name, value) AS (
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
  )
  SELECT string_agg(e.name || ': expected ' || e.value || ', got ' || coalesce(a.value, -1), '; ')
    INTO bad
  FROM expected e LEFT JOIN actual a USING (name)
  WHERE a.value IS DISTINCT FROM e.value;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'content validation failed — rolling back: %', bad;
  END IF;
END \$\$;
COMMIT;
SQL

echo "IMPORT COMMITTED AND VALIDATED against expected-counts.txt"
