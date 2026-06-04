#!/usr/bin/env bash
# One-command staging gate + Gemini judgment.
#
#   ./game-regression/staging/run-and-judge.sh                 # all scenarios
#   STAGING_SCENARIOS="ranked_ai_smoke,reconnect_smoke" ./...   # a subset
#
# Reads secrets from game-regression/staging/.env.staging (gitignored) OR the
# environment. Required there:
#   STAGING_URL                          (default https://api-staging.quizball.io)
#   STAGING_SUPABASE_URL
#   STAGING_SUPABASE_SERVICE_ROLE_KEY
#   OPENROUTER_API_KEY                   (for the Gemini judge)
# Optional: STAGING_SCENARIOS, LLM_JUDGE_MODEL, STAGING_TEST_EMAIL_A/_B
#
# Flow: run real staging matches -> write a report bundle -> Gemini judges each
# scenario against the rulebook -> prints a clear PASS/FAIL verdict you can read.
set -euo pipefail
cd "$(dirname "$0")/../.."   # -> backend-node

ENV_FILE="game-regression/staging/.env.staging"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

: "${STAGING_URL:=https://api-staging.quizball.io}"
export STAGING_URL

if [ -z "${STAGING_SUPABASE_URL:-}" ] || [ -z "${STAGING_SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "Missing STAGING_SUPABASE_URL / STAGING_SUPABASE_SERVICE_ROLE_KEY."
  echo "Put them in $ENV_FILE (gitignored) or export them. See the header of this script."
  exit 2
fi

TAG="$(date +%s)"
export STAGING_RUN_TAG="$TAG"
BUNDLE="game-regression/staging/reports/staging-${TAG}.json"

echo "▶ Running staging scenarios (${STAGING_SCENARIOS:-all})…"
set +e
npm run -s staging:gate
GATE_EXIT=$?
set -e

if [ ! -f "$BUNDLE" ]; then
  echo "No report bundle produced ($BUNDLE) — the run likely failed before completing."
  exit "${GATE_EXIT:-1}"
fi

echo ""
echo "▶ Judging with Gemini…"
npm run -s staging:judge "$BUNDLE"
JUDGE_EXIT=$?

echo ""
echo "Report bundle: $BUNDLE"
exit "$JUDGE_EXIT"
