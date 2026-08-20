import { readFileSync } from 'node:fs';

function migration(name: string): string {
  return readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
}

describe('Road to Goal migration contracts', () => {
  it('uses a dedicated, private idempotency table and backfills committed history', () => {
    const sql = migration('20260820082007_road_to_goal_ledger_keys.sql');

    expect(sql).toContain('idempotency_key text PRIMARY KEY');
    expect(sql).toContain('UNIQUE (round_id, event_type)');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('REVOKE ALL');
    expect(sql).toContain('JOIN public.store_transaction_logs ledger');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
  });

  it('removes interrupted global indexes without rebuilding them on launch', () => {
    const questionIndex = migration('20260818191608_road_to_goal_question_index.sql');
    const ledgerIndex = migration(
      '20260820082006_road_to_goal_repair_ledger_index_drop.sql'
    );

    expect(questionIndex).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS public.idx_questions_road_to_goal_eligible'
    );
    expect(questionIndex).not.toContain('CREATE INDEX CONCURRENTLY');
    expect(ledgerIndex).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS public.uq_store_tx_road_to_goal_idempotency'
    );
    expect(ledgerIndex).not.toContain('CREATE UNIQUE INDEX');
  });

  it('validates both dedicated uniqueness guards', () => {
    const sql = migration('20260820082008_road_to_goal_validate_ledger_keys.sql');

    expect(sql).toContain('road_to_goal_ledger_keys_pkey');
    expect(sql).toContain('road_to_goal_ledger_keys_round_id_event_type_key');
    expect(sql).toContain('index_row.indisvalid');
    expect(sql).toContain('index_row.indisready');
  });
});
