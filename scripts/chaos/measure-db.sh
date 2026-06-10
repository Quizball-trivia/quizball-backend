#!/usr/bin/env bash
# Before/after measurement helper for the db-optimize follow-ups (#2, #3).
# Usage:
#   ./measure-db.sh reset            — reset pg_stat_statements
#   ./measure-db.sh report <label>   — dump targeted + top query stats to stdout
# Reads DATABASE_URL from ../../.env (staging session pooler).
set -euo pipefail
cd "$(dirname "$0")/../.."

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found in $(pwd) — cannot resolve DATABASE_URL." >&2
  exit 1
fi
DB_URL=$(grep -E '^DATABASE_URL=' .env | sed 's/^DATABASE_URL=//; s/^"//; s/"$//' || true)
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: DATABASE_URL not set in .env." >&2
  exit 1
fi

# HARD PROD GUARD — mirror scripts/chaos/run.ts: this script resets/reads
# pg_stat_statements and must never run against the production project.
PROD_PROJECT="lfbwhxvwubzeqkztghok"
if [[ "$DB_URL" == *"$PROD_PROJECT"* || "$DB_URL" == *"api.quizball.io"* ]]; then
  echo "PROD GUARD: DATABASE_URL resolves to production. Refusing to run." >&2
  exit 1
fi
if [[ "$DB_URL" != *"nsdfiprfmhdqhbfxfwpv"* && "$DB_URL" != *"localhost"* && "$DB_URL" != *"127.0.0.1"* ]]; then
  echo "PROD GUARD: DATABASE_URL is neither the staging project nor local. Refusing to run." >&2
  exit 1
fi

if [[ "${1:-}" == "reset" ]]; then
  psql "$DB_URL" -qAt -c "SELECT pg_stat_statements_reset();" >/dev/null
  echo "pg_stat_statements reset at $(date -u +%H:%M:%SZ)"
  exit 0
fi

LABEL="${2:-report}"
echo "===== $LABEL @ $(date -u +%H:%M:%SZ) ====="
echo "--- targeted query shapes ---"
psql "$DB_URL" -P pager=off -c "
SELECT calls,
       round(total_exec_time::numeric,1) AS total_ms,
       round(mean_exec_time::numeric,3)  AS mean_ms,
       rows,
       left(regexp_replace(query, '\\s+', ' ', 'g'), 100) AS query
FROM pg_stat_statements
WHERE query ILIKE '%FROM matches WHERE id =%'
   OR query ILIKE '%pg_catalog.pg_type%'
ORDER BY calls DESC
LIMIT 10;"
echo "--- top 12 by total exec time ---"
psql "$DB_URL" -P pager=off -c "
SELECT calls,
       round(total_exec_time::numeric,1) AS total_ms,
       round(mean_exec_time::numeric,3)  AS mean_ms,
       left(regexp_replace(query, '\\s+', ' ', 'g'), 100) AS query
FROM pg_stat_statements
WHERE query NOT ILIKE '%pg_stat_statements%'
ORDER BY total_exec_time DESC
LIMIT 12;"
