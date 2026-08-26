import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function migration(name: string): string {
  return readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
}

const column = migration('20260826120000_football_grid_points.sql');
const ledger = migration('20260826120001_football_grid_point_ledger.sql');
const indexDrop = migration('20260826120002_football_grid_point_indexes.sql');
const globalIndex = migration('20260826120003_football_grid_point_global_index.sql');
const countryIndex = migration('20260826120004_football_grid_point_country_index.sql');
const indexes = `${globalIndex}\n${countryIndex}`;
const checks = migration('20260826120005_football_grid_point_checks.sql');
const migrationRunner = readFileSync(
  new URL('../../scripts/run-migrations.mjs', import.meta.url),
  'utf8',
);

describe('Football Tic Tac Toe Points migration contract', () => {
  it('keeps the hot users-table expansion short and bounded', () => {
    expect(column).toContain("SET LOCAL lock_timeout = '5s'");
    expect(column).toContain('ADD COLUMN IF NOT EXISTS tic_tac_toe_points integer NOT NULL DEFAULT 0');
    expect(column).toContain('ADD COLUMN IF NOT EXISTS tic_tac_toe_points_updated_at timestamptz');
    expect(column).toContain('users_tic_tac_toe_points_nonnegative_check');
    expect(column).toContain('NOT VALID');
    expect(column).not.toContain('CREATE INDEX');
    expect(column).not.toContain('CREATE TABLE');
    expect(column).not.toContain('UPDATE public.users');
    expect(ledger).not.toContain('UPDATE public.users');
  });

  it('creates a private, idempotent and auditable TP event ledger', () => {
    expect(ledger).toContain('CREATE TABLE IF NOT EXISTS public.football_grid_point_events');
    expect(ledger).toContain('UNIQUE (match_id, user_id, reward_type)');
    expect(ledger).toContain('CREATE TABLE IF NOT EXISTS public.football_grid_point_event_audit');
    expect(ledger).toContain('ALTER TABLE public.football_grid_point_events ENABLE ROW LEVEL SECURITY');
    expect(ledger).toContain('REVOKE ALL ON TABLE');
    expect(ledger).toContain('FROM anon, authenticated');
  });

  it('uses a TP-only timestamp and deterministic user-id leaderboard tie-break', () => {
    expect(column).toContain('tic_tac_toe_points_updated_at timestamptz');
    expect(ledger).not.toContain('ALTER TABLE public.users');
    expect(indexes).toContain('tic_tac_toe_points_updated_at ASC');
    expect(indexes).toContain('id ASC');
    expect(indexes).not.toMatch(/\n\s+updated_at ASC/);
  });

  it('builds global and country leaderboard indexes online', () => {
    expect(indexDrop).toContain('DROP INDEX CONCURRENTLY IF EXISTS');
    expect(globalIndex).toContain('-- migrate:no-transaction');
    expect(countryIndex).toContain('-- migrate:no-transaction');
    expect(indexes.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g)).toHaveLength(2);
    expect(indexes).toContain('idx_users_tic_tac_toe_points_desc');
    expect(indexes).toContain('idx_users_tic_tac_toe_country_points_desc');
    expect(globalIndex.match(/CREATE[\s\S]*?;/g)).toHaveLength(1);
    expect(countryIndex.match(/CREATE[\s\S]*?;/g)).toHaveLength(1);
    expect(migrationRunner).toContain('MIGRATION_ONLINE_DDL_LOCK_TIMEOUT_MS');
    expect(migrationRunner).toContain("'lock_timeout'");
    expect(migrationRunner).toContain('!existingIndex.indisvalid || !existingIndex.indisready');
    expect(migrationRunner).toContain('Dropping interrupted concurrent index');
  });

  it('adds checks without a hot-table validation in the expansion migration', () => {
    expect(column).not.toContain('VALIDATE CONSTRAINT');
    expect(ledger).toContain('NOT VALID');
    expect(ledger).not.toContain('VALIDATE CONSTRAINT');
    expect(checks).toContain('VALIDATE CONSTRAINT users_tic_tac_toe_points_nonnegative_check');
    expect(checks).toContain('VALIDATE CONSTRAINT users_tic_tac_toe_points_timestamp_check');
    expect(checks).toContain('VALIDATE CONSTRAINT football_grid_reward_eligibility_points_decision_check');
  });
});
