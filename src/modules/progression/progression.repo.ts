import { sql, type TransactionSql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import type { XpEventSourceType } from './progression.schemas.js';

export interface GrantXpInput {
  userId: string;
  sourceType: XpEventSourceType;
  sourceKey: string;
  xpDelta: number;
  metadata?: Json | null;
}

export interface GrantXpResult {
  awarded: boolean;
  totalXp: number;
}

function normalizeTotalXp(value: number | string | bigint): number {
  return typeof value === 'number' ? value : Number(value);
}

export const progressionRepo = {
  runInTransaction<T>(callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return sql.begin(callback) as Promise<T>;
  },

  async grantXp(input: GrantXpInput): Promise<GrantXpResult> {
    return this.runInTransaction((tx) => this.grantXpInTx(tx, input));
  },

  async grantXpInTx(tx: TransactionSql, input: GrantXpInput): Promise<GrantXpResult> {
    const [row] = await tx.unsafe<{ awarded: boolean; total_xp: number | string | bigint }[]>(
      `
      WITH inserted AS (
        INSERT INTO user_xp_events (
          user_id,
          source_type,
          source_key,
          xp_delta,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (user_id, source_type, source_key) DO NOTHING
        RETURNING xp_delta
      ),
      updated AS (
        UPDATE users
        SET total_xp = total_xp + COALESCE((SELECT xp_delta FROM inserted), 0)
        WHERE id = $1
        RETURNING total_xp
      )
      SELECT
        EXISTS (SELECT 1 FROM inserted) AS awarded,
        updated.total_xp
      FROM updated
      `,
      [
        input.userId,
        input.sourceType,
        input.sourceKey,
        input.xpDelta,
        JSON.stringify(input.metadata ?? null),
      ]
    );

    return {
      awarded: row?.awarded ?? false,
      totalXp: normalizeTotalXp(row?.total_xp ?? 0),
    };
  },
};
