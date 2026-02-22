import { sql, type TransactionSql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import type {
  StoreProductRow,
  StorePurchaseRow,
  StoreTransactionLogRow,
  StoreTxEventType,
  StoreTxOutcome,
  UserInventoryWithProductRow,
  WalletRow,
} from './store.types.js';
import type { ListStoreTransactionsQuery } from './store.schemas.js';

interface CreatePurchaseInput {
  userId: string;
  productId: string;
  amountCents: number;
  currency: string;
}

interface TransactionLogInput {
  eventType: StoreTxEventType;
  outcome: StoreTxOutcome;
  purchaseId?: string | null;
  userId?: string | null;
  actorUserId?: string | null;
  productId?: string | null;
  stripeCheckoutId?: string | null;
  stripePaymentIntent?: string | null;
  coinsDelta?: number;
  ticketsDelta?: number;
  inventoryDelta?: unknown;
  reason?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  requestId?: string | null;
  metadata?: unknown;
  idempotencyKey?: string | null;
}

interface ListStoreTransactionResult {
  items: StoreTransactionLogRow[];
  total: number;
}

const baseLogsWhereClause = (
  query: ListStoreTransactionsQuery
) => sql`
  (${query.userId ?? null}::uuid IS NULL OR l.user_id = ${query.userId ?? null})
  AND (${query.purchaseId ?? null}::uuid IS NULL OR l.purchase_id = ${query.purchaseId ?? null})
  AND (${query.eventType ?? null}::text IS NULL OR l.event_type = ${query.eventType ?? null})
  AND (${query.outcome ?? null}::text IS NULL OR l.outcome = ${query.outcome ?? null})
  AND (${query.from ?? null}::timestamptz IS NULL OR l.created_at >= ${query.from ?? null}::timestamptz)
  AND (${query.to ?? null}::timestamptz IS NULL OR l.created_at <= ${query.to ?? null}::timestamptz)
`;

export const storeRepo = {
  async listActiveProducts(): Promise<StoreProductRow[]> {
    return sql<StoreProductRow[]>`
      SELECT *
      FROM store_products
      WHERE is_active = true
      ORDER BY sort_order ASC, created_at ASC
    `;
  },

  async getProductBySlug(slug: string, includeInactive = false): Promise<StoreProductRow | null> {
    const [row] = await sql<StoreProductRow[]>`
      SELECT *
      FROM store_products
      WHERE slug = ${slug}
        AND (${includeInactive}::boolean = true OR is_active = true)
      LIMIT 1
    `;
    return row ?? null;
  },

  async getProductBySlugInTx(
    tx: TransactionSql,
    slug: string,
    includeInactive = false
  ): Promise<StoreProductRow | null> {
    const [row] = await tx.unsafe<StoreProductRow[]>(
      `
      SELECT *
      FROM store_products
      WHERE slug = $1
        AND ($2::boolean = true OR is_active = true)
      LIMIT 1
      `,
      [slug, includeInactive]
    );
    return row ?? null;
  },

  async getProductById(id: string): Promise<StoreProductRow | null> {
    const [row] = await sql<StoreProductRow[]>`
      SELECT *
      FROM store_products
      WHERE id = ${id}
      LIMIT 1
    `;
    return row ?? null;
  },

  async getProductByIdInTx(tx: TransactionSql, id: string): Promise<StoreProductRow | null> {
    const [row] = await tx.unsafe<StoreProductRow[]>(
      `
      SELECT *
      FROM store_products
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );
    return row ?? null;
  },

  async createPurchase(data: CreatePurchaseInput): Promise<StorePurchaseRow> {
    const [row] = await sql<StorePurchaseRow[]>`
      INSERT INTO store_purchases (
        user_id,
        product_id,
        amount_cents,
        currency,
        status
      )
      VALUES (
        ${data.userId},
        ${data.productId},
        ${data.amountCents},
        ${data.currency},
        'pending'
      )
      RETURNING *
    `;
    return row;
  },

  async createCompletedPurchaseInTx(
    tx: TransactionSql,
    data: CreatePurchaseInput
  ): Promise<StorePurchaseRow> {
    const [row] = await tx.unsafe<StorePurchaseRow[]>(
      `
      INSERT INTO store_purchases (
        user_id,
        product_id,
        amount_cents,
        currency,
        status,
        fulfilled_at
      )
      VALUES ($1, $2, $3, $4, 'completed', NOW())
      RETURNING *
      `,
      [data.userId, data.productId, data.amountCents, data.currency]
    );
    return row;
  },

  async updatePurchaseStripeCheckoutId(id: string, stripeCheckoutId: string): Promise<void> {
    await sql`
      UPDATE store_purchases
      SET stripe_checkout_id = ${stripeCheckoutId}
      WHERE id = ${id}
    `;
  },

  async markPurchaseFailed(id: string): Promise<void> {
    await sql`
      UPDATE store_purchases
      SET
        status = 'failed'
      WHERE id = ${id}
        AND status = 'pending'
    `;
  },

  async getPurchaseByStripeCheckoutId(checkoutId: string): Promise<StorePurchaseRow | null> {
    const [row] = await sql<StorePurchaseRow[]>`
      SELECT *
      FROM store_purchases
      WHERE stripe_checkout_id = ${checkoutId}
      LIMIT 1
    `;
    return row ?? null;
  },

  async getPurchaseByStripeCheckoutIdInTx(
    tx: TransactionSql,
    checkoutId: string
  ): Promise<StorePurchaseRow | null> {
    const [row] = await tx.unsafe<StorePurchaseRow[]>(
      `
      SELECT *
      FROM store_purchases
      WHERE stripe_checkout_id = $1
      LIMIT 1
      `,
      [checkoutId]
    );
    return row ?? null;
  },

  async markPurchaseCompletedInTx(
    tx: TransactionSql,
    checkoutId: string,
    paymentIntentId: string | null
  ): Promise<StorePurchaseRow | null> {
    const [row] = await tx.unsafe<StorePurchaseRow[]>(
      `
      UPDATE store_purchases
      SET
        status = 'completed',
        stripe_payment_intent = $1,
        fulfilled_at = NOW()
      WHERE stripe_checkout_id = $2
        AND status = 'pending'
      RETURNING *
      `,
      [paymentIntentId, checkoutId]
    );
    return row ?? null;
  },

  async getWallet(userId: string): Promise<WalletRow | null> {
    const [row] = await sql<WalletRow[]>`
      SELECT coins, tickets
      FROM users
      WHERE id = ${userId}
      LIMIT 1
    `;
    return row ?? null;
  },

  async adjustWalletInTx(
    tx: TransactionSql,
    userId: string,
    coinsDelta: number,
    ticketsDelta: number
  ): Promise<WalletRow | null> {
    const [row] = await tx.unsafe<WalletRow[]>(
      `
      UPDATE users
      SET
        coins = coins + $1,
        tickets = tickets + $2,
        updated_at = NOW()
      WHERE id = $3
        AND coins + $1 >= 0
        AND tickets + $2 >= 0
      RETURNING coins, tickets
      `,
      [coinsDelta, ticketsDelta, userId]
    );
    return row ?? null;
  },

  async addCoinsInTx(tx: TransactionSql, userId: string, amount: number): Promise<WalletRow | null> {
    return this.adjustWalletInTx(tx, userId, amount, 0);
  },

  async addTicketsInTx(tx: TransactionSql, userId: string, amount: number): Promise<WalletRow | null> {
    return this.adjustWalletInTx(tx, userId, 0, amount);
  },

  async upsertInventoryInTx(
    tx: TransactionSql,
    userId: string,
    productId: string,
    quantity: number
  ): Promise<void> {
    await tx.unsafe(
      `
      INSERT INTO user_inventory (user_id, product_id, quantity)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, product_id)
      DO UPDATE SET quantity = user_inventory.quantity + EXCLUDED.quantity
      `,
      [userId, productId, quantity]
    );
  },

  async getInventoryQuantityInTx(
    tx: TransactionSql,
    userId: string,
    productId: string
  ): Promise<number | null> {
    const [row] = await tx.unsafe<Array<{ quantity: number }>>(
      `
      SELECT quantity
      FROM user_inventory
      WHERE user_id = $1
        AND product_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [userId, productId]
    );
    return row?.quantity ?? null;
  },

  async deleteInventoryItemInTx(
    tx: TransactionSql,
    userId: string,
    productId: string
  ): Promise<number | null> {
    const deleted = await tx.unsafe<Array<{ product_id: string }>>(
      `
      DELETE FROM user_inventory
      WHERE user_id = $1
        AND product_id = $2
      RETURNING product_id
      `,
      [userId, productId]
    );
    return deleted.length > 0 ? 0 : null;
  },

  async decrementInventoryItemInTx(
    tx: TransactionSql,
    userId: string,
    productId: string
  ): Promise<number | null> {
    const [updated] = await tx.unsafe<Array<{ quantity: number }>>(
      `
      UPDATE user_inventory
      SET quantity = quantity - 1
      WHERE user_id = $1
        AND product_id = $2
        AND quantity > 0
      RETURNING quantity
      `,
      [userId, productId]
    );

    return updated?.quantity ?? null;
  },

  async listInventoryWithProducts(userId: string): Promise<UserInventoryWithProductRow[]> {
    return sql<UserInventoryWithProductRow[]>`
      SELECT
        ui.id as inventory_id,
        ui.user_id,
        ui.product_id,
        ui.quantity,
        ui.acquired_at,
        sp.slug as product_slug,
        sp.type as product_type,
        sp.name as product_name,
        sp.description as product_description,
        sp.metadata as product_metadata
      FROM user_inventory ui
      JOIN store_products sp ON sp.id = ui.product_id
      WHERE ui.user_id = ${userId}
      ORDER BY ui.acquired_at DESC, sp.sort_order ASC
    `;
  },

  async insertTransactionLog(data: TransactionLogInput): Promise<StoreTransactionLogRow> {
    const [row] = await sql<StoreTransactionLogRow[]>`
      INSERT INTO store_transaction_logs (
        event_type,
        outcome,
        purchase_id,
        user_id,
        actor_user_id,
        product_id,
        stripe_checkout_id,
        stripe_payment_intent,
        coins_delta,
        tickets_delta,
        inventory_delta,
        reason,
        error_code,
        error_message,
        request_id,
        metadata,
        idempotency_key
      )
      VALUES (
        ${data.eventType},
        ${data.outcome},
        ${data.purchaseId ?? null},
        ${data.userId ?? null},
        ${data.actorUserId ?? null},
        ${data.productId ?? null},
        ${data.stripeCheckoutId ?? null},
        ${data.stripePaymentIntent ?? null},
        ${data.coinsDelta ?? 0},
        ${data.ticketsDelta ?? 0},
        ${sql.json((data.inventoryDelta ?? {}) as Json)},
        ${data.reason ?? null},
        ${data.errorCode ?? null},
        ${data.errorMessage ?? null},
        ${data.requestId ?? null},
        ${sql.json((data.metadata ?? {}) as Json)},
        ${data.idempotencyKey ?? null}
      )
      RETURNING *
    `;
    return row;
  },

  async insertTransactionLogInTx(
    tx: TransactionSql,
    data: TransactionLogInput
  ): Promise<StoreTransactionLogRow> {
    const [row] = await tx.unsafe<StoreTransactionLogRow[]>(
      `
      INSERT INTO store_transaction_logs (
        event_type,
        outcome,
        purchase_id,
        user_id,
        actor_user_id,
        product_id,
        stripe_checkout_id,
        stripe_payment_intent,
        coins_delta,
        tickets_delta,
        inventory_delta,
        reason,
        error_code,
        error_message,
        request_id,
        metadata,
        idempotency_key
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11::jsonb, $12, $13, $14, $15, $16::jsonb, $17
      )
      RETURNING *
      `,
      [
        data.eventType,
        data.outcome,
        data.purchaseId ?? null,
        data.userId ?? null,
        data.actorUserId ?? null,
        data.productId ?? null,
        data.stripeCheckoutId ?? null,
        data.stripePaymentIntent ?? null,
        data.coinsDelta ?? 0,
        data.ticketsDelta ?? 0,
        JSON.stringify((data.inventoryDelta ?? {}) as Json),
        data.reason ?? null,
        data.errorCode ?? null,
        data.errorMessage ?? null,
        data.requestId ?? null,
        JSON.stringify((data.metadata ?? {}) as Json),
        data.idempotencyKey ?? null,
      ]
    );
    return row;
  },

  async findManualAdjustmentSuccessByIdempotencyKey(
    idempotencyKey: string
  ): Promise<StoreTransactionLogRow | null> {
    const [row] = await sql<StoreTransactionLogRow[]>`
      SELECT *
      FROM store_transaction_logs
      WHERE event_type = 'manual_adjustment_succeeded'
        AND idempotency_key = ${idempotencyKey}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async listTransactionLogs(
    query: ListStoreTransactionsQuery
  ): Promise<ListStoreTransactionResult> {
    const offset = (query.page - 1) * query.limit;

    const [totalRow] = await sql<{ total: number }[]>`
      SELECT COUNT(*)::int as total
      FROM store_transaction_logs l
      WHERE ${baseLogsWhereClause(query)}
    `;

    const items = await sql<StoreTransactionLogRow[]>`
      SELECT l.*
      FROM store_transaction_logs l
      WHERE ${baseLogsWhereClause(query)}
      ORDER BY l.created_at DESC
      LIMIT ${query.limit}
      OFFSET ${offset}
    `;

    return {
      items,
      total: totalRow?.total ?? 0,
    };
  },
};
