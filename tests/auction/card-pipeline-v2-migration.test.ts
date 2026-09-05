import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const migrationsDir = new URL('../../supabase/migrations/', import.meta.url);
const v2Migration = '20260727140000_card_pipeline_v2.sql';
const prerequisites = [
  '20260619090000_auction_content_pipeline.sql',
  '20260619110000_auction_player_market_values.sql',
  '20260619113000_fix_auction_pricing_summary.sql',
  '20260619120000_player_clue_cards.sql',
  '20260620090000_player_clue_card_starting_price.sql',
  '20260722210000_auction_active_only.sql',
];

// CI supplies a dedicated PostgreSQL service. Each run creates and drops only
// its own database; ordinary unit runs without that service explicitly skip.
describe.skipIf(!databaseUrl)('card pipeline migrations in PostgreSQL', () => {
  const databaseName = `card_migration_${randomUUID().replaceAll('-', '')}`;
  let admin: ReturnType<typeof postgres> | undefined;
  let db: ReturnType<typeof postgres>;
  let createdDatabase = false;
  let playerId: string;
  const legacyCardId = '10000000-0000-4000-8000-000000000001';
  let familyId: string;
  let originalColumns: string[];

  const applyMigration = (name: string) => db.unsafe(readFileSync(new URL(name, migrationsDir), 'utf8'));
  const columns = async () => (await db<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'player_clue_card_content_view'
    ORDER BY ordinal_position
  `).map(row => row.column_name);

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('MIGRATION_TEST_DATABASE_URL must use a disposable local PostgreSQL server');
    }
    admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    createdDatabase = true;
    url.pathname = `/${databaseName}`;
    db = postgres(url.toString(), { max: 1, onnotice: () => {} });

    // These two platform primitives precede the content subsystem. All content
    // tables, views, indexes, and triggers below come from real migration files.
    await db.unsafe(`
      CREATE TABLE public.users (id uuid PRIMARY KEY);
      CREATE FUNCTION public.trigger_set_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
    `);
    for (const migration of prerequisites) await applyMigration(migration);
    [{ id: playerId }] = await db<{ id: string }[]>`
      INSERT INTO public.football_players
        (name, transfermarkt_id, active_status, position_group, current_value_eur, image_url)
      VALUES ('Test player', '123', 'active', 'MID', 80000000, 'https://example.com/player.jpg')
      RETURNING id
    `;
    await db`
      INSERT INTO public.player_clue_cards
        (id, football_player_id, locale, clue_1, clue_2, clue_3, difficulty)
      VALUES (${legacyCardId}, ${playerId}, 'en', 'First clue', 'Second clue', 'Third clue', 'medium')
      RETURNING id
    `;
    originalColumns = await columns();
    await applyMigration(v2Migration);
    [{ card_family_id: familyId }] = await db<{ card_family_id: string }[]>`
      SELECT card_family_id FROM public.player_clue_cards WHERE id = ${legacyCardId}
    `;
    await db`
      INSERT INTO public.player_clue_cards
        (id, football_player_id, card_family_id, locale, clue_1, clue_2, clue_3, difficulty)
      VALUES ('10000000-0000-4000-8000-000000000002', ${playerId}, ${familyId}, 'ka', 'ერთი', 'ორი', 'სამი', 'medium')
    `;
  }, 30_000);

  afterAll(async () => {
    try {
      await db?.end();
      if (createdDatabase) await admin!`DROP DATABASE ${admin!(databaseName)}`;
    } finally {
      await admin?.end();
    }
  });

  it('backfills legacy families and enforces unique locale and immutable identity', async () => {
    expect(familyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await db`SELECT locale FROM public.player_clue_cards WHERE card_family_id = ${familyId} ORDER BY locale`)
      .toEqual([{ locale: 'en' }, { locale: 'ka' }]);
    await expect(db`
      INSERT INTO public.player_clue_cards
        (football_player_id, card_family_id, locale, clue_1, clue_2, clue_3, difficulty)
      VALUES (${playerId}, ${familyId}, 'en', 'One', 'Two', 'Three', 'medium')
    `).rejects.toMatchObject({ code: '23505' });
    for (const [column, value] of [
      ['card_family_id', randomUUID()], ['football_player_id', randomUUID()],
      ['variant_key', 'hard'], ['locale', 'ka'],
    ]) {
      await expect(db`UPDATE public.player_clue_cards SET ${db(column)} = ${value} WHERE id = ${legacyCardId}`)
        .rejects.toMatchObject({ code: 'P0001', message: 'player_clue_cards family identity is immutable' });
    }
    await db`UPDATE public.player_clue_cards SET clue_1 = 'Edited', status = 'superseded' WHERE id = ${legacyCardId}`;
    const [edited] = await db`SELECT clue_1, status FROM public.player_clue_cards WHERE id = ${legacyCardId}`;
    expect(edited).toEqual({ clue_1: 'Edited', status: 'superseded' });
  });

  it('rejects invalid variants and duplicate generation attempts, and cascades task deletion', async () => {
    const [{ id: snapshotId }] = await db`
      INSERT INTO public.content_snapshots (source, source_checksum) VALUES ('test', 'checksum') RETURNING id
    `;
    for (const [variant, difficulty] of [['easy', 'medium'], ['medium', 'easy']]) {
      await expect(db`
        INSERT INTO public.card_generation_tasks (snapshot_id, football_player_id, variant_key, target_difficulty)
        VALUES (${snapshotId}, ${playerId}, ${variant}, ${difficulty})
      `).rejects.toMatchObject({ code: '23514' });
    }
    const [{ id: taskId }] = await db`
      INSERT INTO public.card_generation_tasks (snapshot_id, football_player_id, variant_key, target_difficulty)
      VALUES (${snapshotId}, ${playerId}, 'medium', 'medium') RETURNING id
    `;
    await db`
      INSERT INTO public.card_generation_attempts (task_id, attempt_number, task_stage, status)
      VALUES (${taskId}, 1, 'generated', 'success'), (${taskId}, 2, 'verified', 'failed')
    `;
    await expect(db`
      INSERT INTO public.card_generation_attempts (task_id, attempt_number, task_stage, status)
      VALUES (${taskId}, 1, 'generated', 'success')
    `).rejects.toMatchObject({ code: '23505' });
    expect(await db`SELECT attempt_number, status FROM public.card_generation_attempts WHERE task_id = ${taskId} ORDER BY attempt_number`)
      .toEqual([{ attempt_number: 1, status: 'success' }, { attempt_number: 2, status: 'failed' }]);
    await db`DELETE FROM public.card_generation_tasks WHERE id = ${taskId}`;
    expect(await db`SELECT id FROM public.card_generation_attempts WHERE task_id = ${taskId}`).toHaveLength(0);
  });

  it('executes V2 and subsequent price views without changing their public column contract', async () => {
    expect(await columns()).toEqual(originalColumns);
    // V2 prices are keyed by player, so localized cards share a starting price.
    const prices = await db`
      SELECT starting_price_eur FROM public.player_clue_card_content_view WHERE football_player_id = ${playerId}
    `;
    expect(prices).toHaveLength(2);
    expect(prices[0].starting_price_eur).not.toBeNull();
    expect(prices[0].starting_price_eur).toBe(prices[1].starting_price_eur);

    // Later migrations intentionally changed pricing, but must still execute
    // against the same schema and preserve callers' columns and order.
    const laterViews = readdirSync(migrationsDir).filter(name => name > v2Migration && name.endsWith('.sql'))
      .sort().filter(name => readFileSync(new URL(name, migrationsDir), 'utf8')
        .includes('CREATE OR REPLACE VIEW public.player_clue_card_content_view AS'));
    for (const migration of laterViews) {
      await applyMigration(migration);
      expect(await columns(), migration).toEqual(originalColumns);
      const rows = await db`SELECT clue_card_id, football_player_id, starting_price_eur, active_status FROM public.player_clue_card_content_view`;
      expect(rows).toHaveLength(2);
      expect(rows.every(row => row.football_player_id === playerId && row.active_status === 'active' && Number(row.starting_price_eur) > 0)).toBe(true);
    }
  });
});
