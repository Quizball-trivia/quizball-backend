import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const columnMigrationUrl = new URL(
  '../../supabase/migrations/20260826130000_football_grid_bot_governor.sql',
  import.meta.url,
);
const tablesMigrationUrl = new URL(
  '../../supabase/migrations/20260826130001_football_grid_bot_governor_tables.sql',
  import.meta.url,
);
const indexMigrationUrl = new URL(
  '../../supabase/migrations/20260826130002_football_grid_bot_policy_pin_index.sql',
  import.meta.url,
);
const foreignKeysMigrationUrl = new URL(
  '../../supabase/migrations/20260826130003_football_grid_bot_policy_fks.sql',
  import.meta.url,
);
const columnMigration = readFileSync(columnMigrationUrl, 'utf8');
const tablesMigration = readFileSync(tablesMigrationUrl, 'utf8');
const indexMigration = readFileSync(indexMigrationUrl, 'utf8');
const foreignKeysMigration = readFileSync(foreignKeysMigrationUrl, 'utf8');
const migration = [columnMigration, tablesMigration, indexMigration, foreignKeysMigration].join('\n');

describe('Football Tic Tac Toe bot governor migration contract', () => {
  it('adds a nullable, non-boosting match pin without a hot-table default or backfill', () => {
    expect(columnMigration).toContain('ADD COLUMN IF NOT EXISTS bot_strength_adjustment numeric(6,4)');
    expect(columnMigration).toContain('bot_strength_adjustment BETWEEN -0.2000 AND 0.0000');
    expect(columnMigration).toContain('NOT VALID');
    expect(columnMigration).not.toMatch(/ADD COLUMN IF NOT EXISTS bot_strength_adjustment[^;]+DEFAULT/i);
    expect(columnMigration).not.toMatch(/UPDATE public\.football_grid_matches/i);
    expect(columnMigration).not.toContain('CREATE TABLE');
    expect(columnMigration).toContain("SET lock_timeout = '5s'");
    expect(columnMigration).toContain('RESET lock_timeout');
  });

  it('creates server-only state, idempotent observations, and action provenance', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.football_grid_bot_governor_state');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.football_grid_bot_governor_observations');
    expect(migration).toContain('match_id uuid PRIMARY KEY');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.football_grid_bot_action_audits');
    expect(migration).toContain('PRIMARY KEY (match_id, turn_number)');
    for (const table of [
      'football_grid_bot_governor_state',
      'football_grid_bot_governor_observations',
      'football_grid_bot_action_audits',
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`REVOKE ALL PRIVILEGES ON TABLE public.${table}`);
    }
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
  });

  it('only admits competitive score outcomes and recognized completion reasons', () => {
    expect(migration).toContain('outcome_score numeric(2,1) NOT NULL CHECK (outcome_score IN (0.0, 0.5, 1.0))');
    expect(migration).toContain("completion_reason IN ('line', 'board_full', 'turn_limit')");
  });

  it('ties every observation and action audit to a known tier and the match policy pin', () => {
    expect(tablesMigration).toContain("'Academy', 'Youth Prospect', 'Reserve'");
    expect(tablesMigration.match(/FOREIGN KEY \(bot_model_version, bot_config_version, bot_tier\)/g)).toHaveLength(2);
    expect(foreignKeysMigration).toContain('football_grid_bot_governor_observations_match_policy_fk');
    expect(foreignKeysMigration).toContain('football_grid_bot_action_audits_match_policy_fk');
    expect(indexMigration).toContain('football_grid_matches_bot_policy_pin_uidx');
  });

  it('builds the hot-table policy index online in its own one-statement migration', () => {
    expect(indexMigration).toContain('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(indexMigration.match(/CREATE[\s\S]*?;/g)).toHaveLength(1);
    expect(indexMigration).not.toContain('ALTER TABLE');
    expect(tablesMigration).not.toContain('football_grid_matches_bot_policy_pin_uidx');
  });
});
