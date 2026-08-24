import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../supabase/migrations/20260727140000_card_pipeline_v2.sql',
  import.meta.url
);
const migration = readFileSync(migrationUrl, 'utf8');

describe('card pipeline V2 migration contract', () => {
  it('adds and backfills immutable card-family identity with locale uniqueness', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS card_family_id uuid');
    expect(migration).toContain("CHECK (variant_key IN ('medium', 'hard'))");
    expect(migration).toContain("CHECK (target_difficulty IN ('medium', 'hard'))");
    expect(migration).toMatch(
      /UPDATE public\.player_clue_cards\s+SET card_family_id = gen_random_uuid\(\)\s+WHERE card_family_id IS NULL;/
    );
    expect(migration).toContain(
      'ON public.player_clue_cards (card_family_id, locale)'
    );
    expect(migration).toContain('NEW.card_family_id IS DISTINCT FROM OLD.card_family_id');
    expect(migration).toContain('NEW.variant_key IS DISTINCT FROM OLD.variant_key');
  });

  it('provides durable generation attempts and the expanded card lifecycle', () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS public.card_generation_attempts'
    );
    expect(migration).toContain(
      'task_id uuid NOT NULL REFERENCES public.card_generation_tasks(id) ON DELETE CASCADE'
    );
    expect(migration).toContain('UNIQUE (task_id, attempt_number)');
    expect(migration).toContain("'superseded', 'archived'");
  });

  it('preserves the current content-view shape and hashes price by football player', () => {
    const viewDefinition = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE VIEW public.player_clue_card_content_view AS'
      )
    );

    expect(viewDefinition).toContain('pcc.id AS clue_card_id');
    expect(viewDefinition).toContain('pcc.football_player_id');
    expect(viewDefinition).toContain('AS auction_price_eur');
    expect(viewDefinition).toContain(
      'substr(md5(pcc.football_player_id::text), 1, 8)'
    );
    expect(viewDefinition).not.toContain('substr(md5(pcc.id::text)');
    expect(viewDefinition).toMatch(
      /AS starting_price_eur,\s+fp\.active_status\s+FROM/
    );
  });
});
