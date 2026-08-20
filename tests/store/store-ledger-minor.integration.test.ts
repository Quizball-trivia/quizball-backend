import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let schemaAvailable = false;
const keys = [
  'rtg-ledger-old-replica',
  'rtg-ledger-exact-minor',
  'rtg-ledger-inconsistent',
];

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    const [schema] = await sql<{ ready: boolean }[]>`
      SELECT
        to_regprocedure('public.store_transaction_logs_fill_coin_minor()') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'store_transaction_logs'
            AND column_name = 'coins_delta_minor'
            AND is_nullable = 'YES'
        ) AS ready
    `;
    schemaAvailable = schema?.ready ?? false;
  } catch {
    schemaAvailable = false;
  }
});

afterAll(async () => {
  if (!schemaAvailable || !sql) return;
  await sql`
    DELETE FROM store_transaction_logs
    WHERE idempotency_key = ANY(${keys}::text[])
  `;
});

describe('store ledger minor-unit compatibility', () => {
  it('fills old-replica writes, preserves exact writes, and rejects disagreement', async (ctx) => {
    if (!schemaAvailable) return ctx.skip();

    const [historicStyle] = await sql<{ coins_delta_minor: string }[]>`
      INSERT INTO store_transaction_logs (
        event_type, outcome, coins_delta, tickets_delta, inventory_delta, idempotency_key
      ) VALUES (
        'manual_adjustment_succeeded', 'success', 25, 0, '{}'::jsonb, ${keys[0]}
      )
      RETURNING coins_delta_minor
    `;
    expect(Number(historicStyle.coins_delta_minor)).toBe(2_500);

    const [exact] = await sql<{ coins_delta: number; coins_delta_minor: string }[]>`
      INSERT INTO store_transaction_logs (
        event_type, outcome, coins_delta, coins_delta_minor,
        tickets_delta, inventory_delta, idempotency_key
      ) VALUES (
        'road_to_goal_payout', 'success', 25, 2575, 0, '{}'::jsonb, ${keys[1]}
      )
      RETURNING coins_delta, coins_delta_minor
    `;
    expect(exact).toEqual({ coins_delta: 25, coins_delta_minor: '2575' });

    await expect(sql`
      INSERT INTO store_transaction_logs (
        event_type, outcome, coins_delta, coins_delta_minor,
        tickets_delta, inventory_delta, idempotency_key
      ) VALUES (
        'road_to_goal_payout', 'success', 25, 2675, 0, '{}'::jsonb, ${keys[2]}
      )
    `).rejects.toMatchObject({ code: '23514' });
  });
});
