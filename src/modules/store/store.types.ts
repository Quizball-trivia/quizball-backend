import type { Json } from '../../db/types.js';

export const STORE_PRODUCT_TYPES = [
  'coin_pack',
  'ticket_pack',
  'avatar',
  'chance_card',
] as const;

export type StoreProductType = typeof STORE_PRODUCT_TYPES[number];

export const STORE_TX_EVENT_TYPES = [
  'checkout_session_created',
  'checkout_session_failed',
  'webhook_received',
  'webhook_signature_invalid',
  'fulfillment_succeeded',
  'fulfillment_failed',
  'manual_adjustment_succeeded',
  'manual_adjustment_failed',
] as const;

export type StoreTxEventType = typeof STORE_TX_EVENT_TYPES[number];

export const STORE_TX_OUTCOMES = ['success', 'failure'] as const;
export type StoreTxOutcome = typeof STORE_TX_OUTCOMES[number];

export interface StoreProductRow {
  id: string;
  slug: string;
  type: StoreProductType;
  name: Json;
  description: Json;
  price_cents: number;
  currency: string;
  metadata: Json;
  is_active: boolean;
  sort_order: number;
  created_at: string;
}

export interface StorePurchaseRow {
  id: string;
  user_id: string;
  product_id: string;
  stripe_checkout_id: string | null;
  stripe_payment_intent: string | null;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  amount_cents: number;
  currency: string;
  fulfilled_at: string | null;
  created_at: string;
}

export interface UserInventoryRow {
  id: string;
  user_id: string;
  product_id: string;
  quantity: number;
  acquired_at: string;
}

export interface UserInventoryWithProductRow {
  inventory_id: string;
  user_id: string;
  product_id: string;
  quantity: number;
  acquired_at: string;
  product_slug: string;
  product_type: StoreProductType;
  product_name: Json;
  product_description: Json;
  product_metadata: Json;
}

export interface StoreTransactionLogRow {
  id: string;
  event_type: StoreTxEventType;
  outcome: StoreTxOutcome;
  purchase_id: string | null;
  user_id: string | null;
  actor_user_id: string | null;
  product_id: string | null;
  stripe_checkout_id: string | null;
  stripe_payment_intent: string | null;
  coins_delta: number;
  tickets_delta: number;
  inventory_delta: Json;
  reason: string | null;
  error_code: string | null;
  error_message: string | null;
  request_id: string | null;
  metadata: Json;
  idempotency_key: string | null;
  created_at: string;
}

export interface WalletRow {
  coins: number;
  tickets: number;
}

export interface CoinPackMetadata {
  coins: number;
  bonusPercent?: number;
}

export interface TicketPackMetadata {
  tickets: number;
  bonusPercent?: number;
}

export interface AvatarMetadata {
  avatarKey: string;
  assetUrl: string;
}

export interface ChanceCardMetadata {
  effect: 'fifty_fifty';
}

export type ProductMetadata =
  | CoinPackMetadata
  | TicketPackMetadata
  | AvatarMetadata
  | ChanceCardMetadata;

export interface StoreProductResponse {
  id: string;
  slug: string;
  type: StoreProductType;
  name: Record<string, string>;
  description: Record<string, string>;
  priceCents: number;
  currency: string;
  metadata: ProductMetadata;
}

export interface StoreWalletResponse {
  coins: number;
  tickets: number;
}

export interface StoreInventoryItemResponse {
  inventoryId: string;
  productId: string;
  slug: string;
  type: StoreProductType;
  name: Record<string, string>;
  description: Record<string, string>;
  metadata: ProductMetadata;
  quantity: number;
  acquiredAt: string;
}

export interface ManualInventoryGrant {
  productSlug: string;
  quantity: number;
}

export interface ManualAdjustmentInput {
  userId: string;
  coinsDelta?: number;
  ticketsDelta?: number;
  inventoryGrants?: ManualInventoryGrant[];
  reason: string;
  idempotencyKey?: string;
}

export interface ManualAdjustmentResult {
  applied: boolean;
  wallet: StoreWalletResponse;
  inventoryApplied: ManualInventoryGrant[];
}
