#!/usr/bin/env bash
# Build (or rebuild) the native-Postgres regression DB for the game harness.
# No Docker. Requires native postgresql@16 running (brew services start postgresql@16).
#
# Usage:  bash game-regression/setup-native-db.sh
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
export PGPASSWORD=postgres

ADMIN="postgresql://postgres:postgres@127.0.0.1:5432/postgres"
DB="quizball_regression"
DBCONN="postgresql://postgres:postgres@127.0.0.1:5432/${DB}"
MIGRATIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/supabase/migrations"

# 0) Ensure a password-auth 'postgres' superuser exists (brew uses your mac user).
psql -d postgres -v ON_ERROR_STOP=0 >/dev/null 2>&1 <<'SQL' || true
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='postgres') THEN
    CREATE ROLE postgres LOGIN SUPERUSER PASSWORD 'postgres';
  ELSE
    ALTER ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'postgres';
  END IF;
END $$;
SQL

echo "Dropping + recreating ${DB}..."
psql "$ADMIN" -c "DROP DATABASE IF EXISTS ${DB};" -c "CREATE DATABASE ${DB} OWNER postgres;" >/dev/null

echo "Bootstrapping roles + extensions + pg_cron stub..."
# Roles are CLUSTER-global (persist across DB drops), so create them idempotently.
psql "$ADMIN" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'postgres'; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin LOGIN SUPERUSER PASSWORD 'postgres'; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE PASSWORD 'postgres'; END IF;
END $$;
GRANT anon, authenticated, service_role TO authenticator;
SQL
psql "$DBCONN" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- pg_cron is not available natively; stub the schema + no-op functions so the
-- cron-scheduling migrations apply harmlessly (the harness needs no cron jobs).
CREATE SCHEMA IF NOT EXISTS cron;
CREATE OR REPLACE FUNCTION cron.schedule(text, text, text) RETURNS bigint LANGUAGE sql AS $f$ SELECT 1::bigint $f$;
CREATE OR REPLACE FUNCTION cron.schedule(text, text) RETURNS bigint LANGUAGE sql AS $f$ SELECT 1::bigint $f$;
CREATE OR REPLACE FUNCTION cron.unschedule(text) RETURNS boolean LANGUAGE sql AS $f$ SELECT true $f$;
CREATE OR REPLACE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS $f$ SELECT true $f$;
CREATE TABLE IF NOT EXISTS cron.job (jobid bigint, jobname text, schedule text, command text);
SQL

echo "Applying migrations (stripping CREATE EXTENSION pg_cron)..."
n=0
for f in $(ls "${MIGRATIONS_DIR}"/*.sql | sort); do
  sed -E '/CREATE EXTENSION[^;]*pg_cron/d' "$f" | psql "$DBCONN" -v ON_ERROR_STOP=1 -q
  n=$((n+1))
done

tables=$(psql "$DBCONN" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")
echo "✅ Done: ${n} migrations applied, ${tables} public tables in ${DB}."
echo "   DB URL: ${DBCONN}"
