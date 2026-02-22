import { z } from 'zod';
import {
  STORE_PRODUCT_TYPES,
  STORE_TX_EVENT_TYPES,
  STORE_TX_OUTCOMES,
} from './store.types.js';

export const i18nMapSchema = z.record(z.string(), z.string()).default({});
export const nullableJsonObjectSchema = z.record(z.string(), z.unknown()).nullable();

export const coinPackMetadataSchema = z.object({
  coins: z.number().int().positive(),
  bonusPercent: z.number().int().min(0).max(100).optional(),
});

export const ticketPackMetadataSchema = z.object({
  tickets: z.number().int().positive(),
  bonusPercent: z.number().int().min(0).max(100).optional(),
});

export const avatarMetadataSchema = z.object({
  avatarKey: z.string().min(1),
  assetUrl: z.string().min(1),
});

export const chanceCardMetadataSchema = z.object({
  effect: z.literal('fifty_fifty'),
});

export const createCheckoutBodySchema = z.object({
  productSlug: z.string().min(1).max(120),
});

export const purchaseWithCoinsBodySchema = z.object({
  productSlug: z.string().min(1).max(120),
});

export const storeProductTypeSchema = z.enum(STORE_PRODUCT_TYPES);

export const storeTxEventTypeSchema = z.enum(STORE_TX_EVENT_TYPES);

export const storeTxOutcomeSchema = z.enum(STORE_TX_OUTCOMES);

export const storeProductResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  type: storeProductTypeSchema,
  name: i18nMapSchema,
  description: i18nMapSchema,
  priceCents: z.number().int().positive(),
  currency: z.string(),
  metadata: nullableJsonObjectSchema,
});

export const storeProductsResponseSchema = z.object({
  items: z.array(storeProductResponseSchema),
});

export const storeWalletResponseSchema = z.object({
  coins: z.number().int().nonnegative(),
  tickets: z.number().int().nonnegative(),
});

export const storeInventoryItemSchema = z.object({
  inventoryId: z.string().uuid(),
  productId: z.string().uuid(),
  slug: z.string(),
  type: storeProductTypeSchema,
  name: i18nMapSchema,
  description: i18nMapSchema,
  metadata: nullableJsonObjectSchema,
  quantity: z.number().int().positive(),
  acquiredAt: z.string().datetime(),
});

export const storeInventoryResponseSchema = z.object({
  items: z.array(storeInventoryItemSchema),
});

export const createCheckoutResponseSchema = z.object({
  url: z.string().url(),
});

export const purchaseWithCoinsResponseSchema = z.object({
  wallet: storeWalletResponseSchema,
});

export const devGrantSelfBodySchema = z
  .object({
    coinsDelta: z.number().int().min(0).max(100000).optional(),
    ticketsDelta: z.number().int().min(0).max(10000).optional(),
  })
  .superRefine((value, ctx) => {
    const hasCoins = typeof value.coinsDelta === 'number' && value.coinsDelta > 0;
    const hasTickets = typeof value.ticketsDelta === 'number' && value.ticketsDelta > 0;
    if (!hasCoins && !hasTickets) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one positive grant is required',
      });
    }
  });

export const devGrantSelfResponseSchema = z.object({
  wallet: storeWalletResponseSchema,
});

export const manualInventoryGrantSchema = z.object({
  productSlug: z.string().min(1).max(120),
  quantity: z.number().int().positive().max(999).default(1),
});

export const manualAdjustmentBodySchema = z
  .object({
    userId: z.string().uuid(),
    coinsDelta: z.number().int().optional(),
    ticketsDelta: z.number().int().optional(),
    inventoryGrants: z.array(manualInventoryGrantSchema).optional(),
    reason: z.string().min(3).max(500),
    idempotencyKey: z.string().min(3).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    const hasCoins = typeof value.coinsDelta === 'number' && value.coinsDelta !== 0;
    const hasTickets = typeof value.ticketsDelta === 'number' && value.ticketsDelta !== 0;
    const hasInventory = Array.isArray(value.inventoryGrants) && value.inventoryGrants.length > 0;

    if (!hasCoins && !hasTickets && !hasInventory) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one adjustment is required',
      });
    }
  });

export const manualAdjustmentResponseSchema = z.object({
  applied: z.boolean(),
  wallet: storeWalletResponseSchema,
  inventoryApplied: z.array(manualInventoryGrantSchema),
});

export const listStoreTransactionsQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  purchaseId: z.string().uuid().optional(),
  eventType: storeTxEventTypeSchema.optional(),
  outcome: storeTxOutcomeSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const storeTransactionLogResponseSchema = z.object({
  id: z.string().uuid(),
  eventType: storeTxEventTypeSchema,
  outcome: storeTxOutcomeSchema,
  purchaseId: z.string().uuid().nullable(),
  userId: z.string().uuid().nullable(),
  actorUserId: z.string().uuid().nullable(),
  productId: z.string().uuid().nullable(),
  stripeCheckoutId: z.string().nullable(),
  stripePaymentIntent: z.string().nullable(),
  coinsDelta: z.number().int(),
  ticketsDelta: z.number().int(),
  inventoryDelta: nullableJsonObjectSchema,
  reason: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  requestId: z.string().nullable(),
  metadata: nullableJsonObjectSchema,
  idempotencyKey: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const listStoreTransactionsResponseSchema = z.object({
  items: z.array(storeTransactionLogResponseSchema),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

export type CreateCheckoutBody = z.infer<typeof createCheckoutBodySchema>;
export type PurchaseWithCoinsBody = z.infer<typeof purchaseWithCoinsBodySchema>;
export type DevGrantSelfBody = z.infer<typeof devGrantSelfBodySchema>;
export type ManualAdjustmentBody = z.infer<typeof manualAdjustmentBodySchema>;
export type ListStoreTransactionsQuery = z.infer<typeof listStoreTransactionsQuerySchema>;
