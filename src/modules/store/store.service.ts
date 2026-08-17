import { z } from 'zod';
import { sql, type TransactionSql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import { config } from '../../core/config.js';
import { AppError, BadRequestError, ErrorCode, ExternalServiceError, NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { getRequestId } from '../../core/request-context.js';
import { usersRepo } from '../users/users.repo.js';
import { storeRepo } from './store.repo.js';
import { notificationsService } from '../notifications/notifications.service.js';
import { stripe } from './stripe.js';
import {
  MAX_TICKETS,
  TICKET_PURCHASE_MAX_TICKETS_PER_WINDOW,
  resolveHydratedTicketState,
  ticketRefillService,
} from './ticket-refill.service.js';
import {
  avatarMetadataSchema,
  chanceCardMetadataSchema,
  coinPackMetadataSchema,
  type DevGrantSelfBody,
  i18nMapSchema,
  manualInventoryGrantSchema,
  storeWalletResponseSchema,
  ticketPackMetadataSchema,
  type ListStoreTransactionsQuery,
} from './store.schemas.js';
import type {
  ManualAdjustmentInput,
  ManualAdjustmentResult,
  ProductMetadata,
  StoreInventoryItemResponse,
  StoreProductResponse,
  StorePurchaseRow,
  StoreProductRow,
  StoreTransactionLogRow,
  StoreWalletResponse,
  WalletRow,
} from './store.types.js';

const manualAdjustmentLogMetadataSchema = z.object({
  walletAfter: storeWalletResponseSchema.or(
    z.object({
      coins: z.number().int().nonnegative(),
      tickets: z.number().int().nonnegative(),
    }).transform((wallet) => ({
      ...wallet,
      ticketPurchaseCooldown: {
        canBuy: true,
        nextAvailableAt: null,
        remainingSeconds: 0,
        ticketsRemainingInWindow: TICKET_PURCHASE_MAX_TICKETS_PER_WINDOW,
      },
    }))
  ),
  inventoryApplied: z.array(manualInventoryGrantSchema),
});

// Players can buy up to TICKET_PURCHASE_MAX_TICKETS_PER_WINDOW *tickets* per
// FIXED daily window (quantity-based: the 5-pack uses the whole daily allowance,
// a 1-pack plus a 3-pack leaves room for one more single). The whole allowance
// RESETS TOGETHER at the start of each day, so the full-allowance 5-pack is
// always buyable right after a reset.
//
// The window resets at 00:00 Georgia time (Asia/Tbilisi = fixed UTC+4, no DST —
// see supabase/migrations/20260620000000_global_ticket_refill_cron.sql), i.e.
// 20:00 UTC. This mirrors the global ticket-refill cron's fixed Georgia grid.
//
// Previously this was a ROLLING 24h window keyed off each purchase's timestamp,
// which meant capacity trickled back in fragments (a 3+1+1 day never freed a
// contiguous block of 5) so the 5-pack was effectively never buyable — forcing
// players into pricier 3+1+1 (8,000 coins) instead of the 5-pack (5,000 coins).
const GEORGIA_UTC_OFFSET_MS = 4 * 60 * 60 * 1000; // Asia/Tbilisi, fixed UTC+4
const DAY_MS = 24 * 60 * 60 * 1000;

// Start of the current fixed daily window (most recent 00:00 Georgia time) and
// the next reset instant, computed arithmetically (safe because Tbilisi has no DST).
function getTicketPurchaseWindowBounds(now = new Date()): {
  windowStartMs: number;
  nextResetMs: number;
} {
  const nowMs = now.getTime();
  const windowStartMs = Math.floor((nowMs + GEORGIA_UTC_OFFSET_MS) / DAY_MS) * DAY_MS - GEORGIA_UTC_OFFSET_MS;
  return { windowStartMs, nextResetMs: windowStartMs + DAY_MS };
}

/** ISO timestamp of the current fixed daily window start (the `since` boundary). */
function ticketPurchaseWindowSinceIso(now = new Date()): string {
  return new Date(getTicketPurchaseWindowBounds(now).windowStartMs).toISOString();
}

type TicketPurchaseCooldown = StoreWalletResponse['ticketPurchaseCooldown'];

function buildTicketPurchaseCooldown(
  windowTicketCount: number,
  now = new Date()
): TicketPurchaseCooldown {
  const ticketsRemainingInWindow = Math.max(
    0,
    TICKET_PURCHASE_MAX_TICKETS_PER_WINDOW - Math.max(0, windowTicketCount)
  );

  // Under the per-window ticket cap → at least a single ticket is buyable now.
  if (ticketsRemainingInWindow > 0) {
    return { canBuy: true, nextAvailableAt: null, remainingSeconds: 0, ticketsRemainingInWindow };
  }

  // At the cap: the whole allowance frees at the next fixed daily reset.
  const { nextResetMs } = getTicketPurchaseWindowBounds(now);
  const remainingMs = nextResetMs - now.getTime();
  if (remainingMs <= 0) {
    return { canBuy: true, nextAvailableAt: null, remainingSeconds: 0, ticketsRemainingInWindow };
  }

  return {
    canBuy: false,
    nextAvailableAt: new Date(nextResetMs).toISOString(),
    remainingSeconds: Math.ceil(remainingMs / 1000),
    ticketsRemainingInWindow,
  };
}

function buildWalletResponse(
  wallet: Pick<StoreWalletResponse, 'coins' | 'tickets'>,
  ticketPurchaseCooldown: TicketPurchaseCooldown
): StoreWalletResponse {
  return {
    coins: wallet.coins,
    tickets: wallet.tickets,
    ticketPurchaseCooldown,
  };
}

// Loads the real ticket-purchase cooldown for a user so wallet responses never
// default to "purchasable" regardless of purchase history. Enforces the fixed
// daily ticket-quantity cap (up to TICKET_PURCHASE_MAX_TICKETS_PER_WINDOW tickets
// per Georgia-time day).
async function loadTicketPurchaseCooldownInTx(
  tx: TransactionSql,
  userId: string
): Promise<TicketPurchaseCooldown> {
  // Capture one instant so the query boundary and the cooldown calc agree even
  // if the read straddles the daily reset boundary.
  const now = new Date();
  const sinceIso = ticketPurchaseWindowSinceIso(now);
  const window = await storeRepo.getTicketPackPurchaseWindowInTx(tx, userId, sinceIso);
  return buildTicketPurchaseCooldown(window.ticketCount, now);
}

function assertCanBuyTicketPack(
  cooldown: TicketPurchaseCooldown,
  userId: string,
  packTickets: number
): void {
  if (cooldown.canBuy && packTickets <= cooldown.ticketsRemainingInWindow) return;
  throw new AppError(
    `Ticket purchase limit reached (up to ${TICKET_PURCHASE_MAX_TICKETS_PER_WINDOW} tickets per 24 hours)`,
    400,
    ErrorCode.TICKET_PURCHASE_COOLDOWN,
    {
      userId,
      requestedTickets: packTickets,
      ticketsRemainingInWindow: cooldown.ticketsRemainingInWindow,
      nextAvailableAt: cooldown.nextAvailableAt,
      remainingSeconds: cooldown.remainingSeconds,
    }
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Unknown error';
}

function getErrorCode(error: unknown): string | null {
  if (error instanceof AppError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const raw = (error as { code: unknown }).code;
    if (typeof raw === 'string') return raw;
  }
  return null;
}

function parseI18nField(value: unknown): Record<string, string> {
  const parsed = i18nMapSchema.safeParse(value);
  if (!parsed.success) return {};
  return parsed.data;
}

function parseProductMetadataByType(
  productType: StoreProductRow['type'],
  rawMetadata: unknown,
  context: { productId: string; slug: string }
): ProductMetadata {
  switch (productType) {
    case 'coin_pack': {
      const parsed = coinPackMetadataSchema.safeParse(rawMetadata);
      if (!parsed.success) {
        throw new AppError(
          'Invalid coin pack metadata',
          500,
          ErrorCode.INTERNAL_ERROR,
          context
        );
      }
      return parsed.data;
    }
    case 'ticket_pack': {
      const parsed = ticketPackMetadataSchema.safeParse(rawMetadata);
      if (!parsed.success) {
        throw new AppError(
          'Invalid ticket pack metadata',
          500,
          ErrorCode.INTERNAL_ERROR,
          context
        );
      }
      return parsed.data;
    }
    case 'avatar': {
      const parsed = avatarMetadataSchema.safeParse(rawMetadata);
      if (!parsed.success) {
        throw new AppError(
          'Invalid avatar metadata',
          500,
          ErrorCode.INTERNAL_ERROR,
          context
        );
      }
      return parsed.data;
    }
    case 'chance_card': {
      const parsed = chanceCardMetadataSchema.safeParse(rawMetadata);
      if (!parsed.success) {
        throw new AppError(
          'Invalid chance card metadata',
          500,
          ErrorCode.INTERNAL_ERROR,
          context
        );
      }
      return parsed.data;
    }
    default:
      throw new AppError('Unsupported product type', 500, ErrorCode.INTERNAL_ERROR, {
        productId: context.productId,
        productType: productType,
      });
  }
}

function parseProductMetadata(product: StoreProductRow): ProductMetadata {
  return parseProductMetadataByType(
    product.type,
    product.metadata,
    { productId: product.id, slug: product.slug }
  );
}

function toStoreProductResponse(row: StoreProductRow): StoreProductResponse {
  return {
    id: row.id,
    slug: row.slug,
    type: row.type,
    name: parseI18nField(row.name),
    description: parseI18nField(row.description),
    priceCents: row.price_cents,
    currency: row.currency,
    metadata: parseProductMetadata(row),
  };
}

function appendCheckoutSessionId(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
  return parsed.toString();
}

function isPgUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code: unknown }).code === '23505';
}

function toStoreTransactionLogResponse(row: StoreTransactionLogRow) {
  return {
    id: row.id,
    eventType: row.event_type,
    outcome: row.outcome,
    purchaseId: row.purchase_id,
    userId: row.user_id,
    actorUserId: row.actor_user_id,
    productId: row.product_id,
    stripeCheckoutId: row.stripe_checkout_id,
    stripePaymentIntent: row.stripe_payment_intent,
    coinsDelta: row.coins_delta,
    ticketsDelta: row.tickets_delta,
    inventoryDelta: row.inventory_delta,
    reason: row.reason,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    requestId: row.request_id,
    metadata: row.metadata,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function buildCoinPurchaseFailureContext(
  product: StoreProductRow | null,
  fallbackSlug: string
): {
  productId: string | null;
  coinsDelta: number;
  productSlug: string;
  productType: StoreProductRow['type'] | null;
} {
  if (!product) {
    return {
      productId: null,
      coinsDelta: 0,
      productSlug: fallbackSlug,
      productType: null,
    };
  }

  return {
    productId: product.id,
    coinsDelta: product.type === 'coin_pack' ? 0 : -product.price_cents,
    productSlug: product.slug,
    productType: product.type,
  };
}

async function applyWalletAdjustmentInTx(
  tx: TransactionSql,
  userId: string,
  adjustments: {
    coinsDelta: number;
    ticketsDelta: number;
    rejectTicketOverflow?: boolean;
    insufficientCoinsMessage?: string;
  }
): Promise<{ wallet: StoreWalletResponse; appliedTicketsDelta: number }> {
  const nowIso = new Date().toISOString();
  const wallet = await storeRepo.getWalletForUpdateInTx(tx, userId);
  if (!wallet) {
    throw new NotFoundError('User not found');
  }

  const hydrated = resolveHydratedTicketState(wallet, nowIso);
  const currentCoins = wallet.coins;
  const currentTickets = hydrated.tickets;
  const currentAnchor = hydrated.ticketsRefillStartedAt;
  const nextCoins = currentCoins + adjustments.coinsDelta;

  if (nextCoins < 0) {
    throw new BadRequestError(
      adjustments.insufficientCoinsMessage ?? 'Not enough coins for this purchase'
    );
  }

  let nextTickets = currentTickets;
  let nextAnchor = currentAnchor;
  let appliedTicketsDelta = 0;

  if (adjustments.ticketsDelta > 0) {
    const availableSpace = Math.max(0, MAX_TICKETS - currentTickets);
    if (availableSpace === 0 || (adjustments.rejectTicketOverflow && adjustments.ticketsDelta > availableSpace)) {
      throw new AppError(
        'Tickets are already full',
        400,
        ErrorCode.TICKETS_FULL,
        {
          userId,
          requestedAmount: adjustments.ticketsDelta,
          availableSpace,
          maxTickets: MAX_TICKETS,
        }
      );
    }
    appliedTicketsDelta = Math.min(adjustments.ticketsDelta, availableSpace);
    nextTickets = currentTickets + appliedTicketsDelta;
    nextAnchor = nextTickets >= MAX_TICKETS ? null : currentAnchor;
  } else if (adjustments.ticketsDelta < 0) {
    if (currentTickets + adjustments.ticketsDelta < 0) {
      throw new BadRequestError('Manual adjustment would result in negative ticket balance', {
        userId,
      });
    }
    appliedTicketsDelta = adjustments.ticketsDelta;
    nextTickets = currentTickets + adjustments.ticketsDelta;
    nextAnchor = nextTickets >= MAX_TICKETS ? null : currentAnchor ?? nowIso;
  }

  const updated = await storeRepo.setWalletStateInTx(tx, userId, {
    coins: nextCoins,
    tickets: nextTickets,
    ticketsRefillStartedAt: nextAnchor,
  });
  if (!updated) {
    throw new NotFoundError('User not found');
  }

  return {
    wallet: buildWalletResponse(updated, await loadTicketPurchaseCooldownInTx(tx, userId)),
    appliedTicketsDelta,
  };
}

/**
 * Notify a user about coins/tickets they received via an admin adjustment.
 * Best-effort: the wallet change has already committed; a notification failure
 * must not surface to the caller.
 */
async function notifyWalletChange(
  userId: string,
  change: { coinsDelta: number; ticketsDelta: number; reason: string }
): Promise<void> {
  const parts: string[] = [];
  const partsKa: string[] = [];
  if (change.coinsDelta !== 0) {
    parts.push(`${change.coinsDelta > 0 ? '+' : ''}${change.coinsDelta} coins`);
    partsKa.push(`${change.coinsDelta > 0 ? '+' : ''}${change.coinsDelta} მონეტა`);
  }
  if (change.ticketsDelta !== 0) {
    parts.push(`${change.ticketsDelta > 0 ? '+' : ''}${change.ticketsDelta} tickets`);
    partsKa.push(`${change.ticketsDelta > 0 ? '+' : ''}${change.ticketsDelta} ბილეთი`);
  }
  if (parts.length === 0) return;

  try {
    await notificationsService.notify(userId, {
      type: 'points_adjustment',
      title: { en: 'Your wallet was updated', ka: 'შენი საფულე განახლდა' },
      body: { en: `You received ${parts.join(' and ')}.`, ka: `მიიღე ${partsKa.join(' და ')}.` },
      data: { coinsDelta: change.coinsDelta, ticketsDelta: change.ticketsDelta, reason: change.reason },
    });
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to send wallet-change notification');
  }
}

export const storeService = {
  async listProducts(): Promise<{ items: StoreProductResponse[] }> {
    const rows = await storeRepo.listActiveProducts();
    return { items: rows.map(toStoreProductResponse) };
  },

  async createCheckoutSession(userId: string, productSlug: string): Promise<{ url: string }> {
    if (!stripe || !config.STRIPE_SUCCESS_URL || !config.STRIPE_CANCEL_URL) {
      throw new ExternalServiceError('Stripe is not configured');
    }

    const product = await storeRepo.getProductBySlug(productSlug);
    if (!product || !product.is_active) {
      throw new NotFoundError('Store product not found');
    }
    if (product.type !== 'coin_pack' && product.type !== 'ticket_pack') {
      throw new BadRequestError('Only coin packs and ticket packs are purchasable via Stripe checkout');
    }

    if (product.type === 'ticket_pack') {
      const parsed = ticketPackMetadataSchema.safeParse(product.metadata);
      if (!parsed.success) {
        throw new AppError(
          'Invalid ticket pack metadata',
          500,
          ErrorCode.INTERNAL_ERROR,
          { productId: product.id, slug: product.slug }
        );
      }

      const wallet = await storeRepo.getWallet(userId);
      if (!wallet) {
        throw new NotFoundError('User not found');
      }
      const hydratedWallet = resolveHydratedTicketState(wallet);
      const availableSpace = Math.max(0, MAX_TICKETS - hydratedWallet.tickets);
      if (availableSpace === 0 || parsed.data.tickets > availableSpace) {
        throw new AppError(
          'Tickets are already full',
          400,
          ErrorCode.TICKETS_FULL,
          {
            userId,
            requestedAmount: parsed.data.tickets,
            availableSpace,
            maxTickets: MAX_TICKETS,
            productSlug,
          }
        );
      }
    }
    let purchase: StorePurchaseRow | null = null;

    try {
      purchase = await storeRepo.createPurchase({
        userId,
        productId: product.id,
        amountCents: product.price_cents,
        currency: product.currency,
      });

      const name = parseI18nField(product.name).en ?? product.slug;
      const description = parseI18nField(product.description).en ?? undefined;

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: product.currency,
            unit_amount: product.price_cents,
            product_data: {
              name,
              description,
            },
          },
          quantity: 1,
        }],
        metadata: {
          purchaseId: purchase.id,
          userId,
          productSlug: product.slug,
          productType: product.type,
        },
        branding_settings: {
          display_name: 'Quizball',
          background_color: '#131F24',
          button_color: '#58CC02',
          font_family: 'nunito',
          border_style: 'pill',
        },
        success_url: appendCheckoutSessionId(config.STRIPE_SUCCESS_URL),
        cancel_url: config.STRIPE_CANCEL_URL,
      });

      if (!session.url) {
        throw new ExternalServiceError('Stripe checkout session did not return a URL');
      }

      await storeRepo.updatePurchaseStripeCheckoutId(purchase.id, session.id);
      await storeRepo.insertTransactionLog({
        eventType: 'checkout_session_created',
        outcome: 'success',
        purchaseId: purchase.id,
        userId,
        productId: product.id,
        stripeCheckoutId: session.id,
        requestId: getRequestId(),
        metadata: {
          productSlug: product.slug,
          productType: product.type,
        } as unknown as Json,
      });

      return { url: session.url };
    } catch (error) {
      if (purchase) {
        await storeRepo.markPurchaseFailed(purchase.id);
      }

      await storeRepo.insertTransactionLog({
        eventType: 'checkout_session_failed',
        outcome: 'failure',
        purchaseId: purchase?.id ?? null,
        userId,
        productId: product.id,
        errorCode: getErrorCode(error),
        errorMessage: getErrorMessage(error),
        requestId: getRequestId(),
        metadata: {
          productSlug: product.slug,
          productType: product.type,
        } as unknown as Json,
      });

      logger.error({ err: error, userId, productSlug }, 'Failed to create Stripe checkout session');
      if (error instanceof AppError) {
        throw error;
      }
      throw new ExternalServiceError('Failed to create checkout session');
    }
  },

  async purchaseWithCoins(
    userId: string,
    productSlug: string
  ): Promise<{ wallet: StoreWalletResponse }> {
    let productForError: StoreProductRow | null = null;

    try {
      const wallet = await sql.begin(async (tx) => {
        const product = await storeRepo.getProductBySlugInTx(tx, productSlug);
        productForError = product;

        if (!product || !product.is_active) {
          throw new NotFoundError('Store product not found');
        }

        if (product.type === 'coin_pack') {
          throw new BadRequestError('Coin packs must be purchased via Stripe checkout');
        }

        const coinsCost = product.price_cents;
        if (!Number.isInteger(coinsCost) || coinsCost <= 0) {
          throw new AppError('Invalid coin purchase price', 500, ErrorCode.INTERNAL_ERROR, {
            productId: product.id,
            slug: product.slug,
            priceCents: product.price_cents,
          });
        }

        let walletAfter: StoreWalletResponse;
        let ticketsDelta = 0;
        let inventoryDelta: Record<string, number> = {};

        switch (product.type) {
          case 'ticket_pack': {
            const walletForLock = await storeRepo.getWalletForUpdateInTx(tx, userId);
            if (!walletForLock) {
              throw new NotFoundError('User not found');
            }

            const parsed = ticketPackMetadataSchema.safeParse(product.metadata);
            if (!parsed.success) {
              throw new AppError(
                'Invalid ticket pack metadata',
                500,
                ErrorCode.INTERNAL_ERROR,
                { productId: product.id, slug: product.slug }
              );
            }

            assertCanBuyTicketPack(
              await loadTicketPurchaseCooldownInTx(tx, userId),
              userId,
              parsed.data.tickets
            );

            const updatedWallet = await applyWalletAdjustmentInTx(tx, userId, {
              coinsDelta: -coinsCost,
              ticketsDelta: parsed.data.tickets,
              rejectTicketOverflow: true,
              insufficientCoinsMessage: 'Not enough coins for this purchase',
            });
            walletAfter = buildWalletResponse(
              updatedWallet.wallet,
              await loadTicketPurchaseCooldownInTx(tx, userId)
            );
            ticketsDelta = updatedWallet.appliedTicketsDelta;
            break;
          }
          case 'avatar':
          case 'chance_card': {
            const updatedWallet = await applyWalletAdjustmentInTx(tx, userId, {
              coinsDelta: -coinsCost,
              ticketsDelta: 0,
              insufficientCoinsMessage: 'Not enough coins for this purchase',
            });
            walletAfter = updatedWallet.wallet;
            await storeRepo.upsertInventoryInTx(tx, userId, product.id, 1);
            inventoryDelta = { [product.slug]: 1 };
            break;
          }
          default:
            throw new AppError(
              'Unsupported product type for coin purchase',
              500,
              ErrorCode.INTERNAL_ERROR,
              { productId: product.id, productType: product.type }
            );
        }

        const purchase = await storeRepo.createCompletedPurchaseInTx(tx, {
          userId,
          productId: product.id,
          amountCents: coinsCost,
          currency: 'coins',
        });

        await storeRepo.insertTransactionLogInTx(tx, {
          eventType: 'fulfillment_succeeded',
          outcome: 'success',
          purchaseId: purchase.id,
          userId,
          productId: product.id,
          coinsDelta: -coinsCost,
          ticketsDelta,
          inventoryDelta,
          reason: 'coin_purchase',
          requestId: getRequestId(),
          metadata: {
            productSlug: product.slug,
            productType: product.type,
            currency: 'coins',
          } as unknown as Json,
        });

        return walletAfter;
      });

      return { wallet };
    } catch (error) {
      const failureContext = buildCoinPurchaseFailureContext(productForError, productSlug);

      await storeRepo.insertTransactionLog({
        eventType: 'fulfillment_failed',
        outcome: 'failure',
        userId,
        productId: failureContext.productId,
        coinsDelta: failureContext.coinsDelta,
        reason: 'coin_purchase',
        errorCode: getErrorCode(error),
        errorMessage: getErrorMessage(error),
        requestId: getRequestId(),
        metadata: {
          productSlug: failureContext.productSlug,
          productType: failureContext.productType,
          currency: 'coins',
        } as unknown as Json,
      });

      throw error;
    }
  },

  async fulfillCheckout(stripeCheckoutId: string, paymentIntentId: string | null): Promise<void> {
    let purchaseForFailure: StorePurchaseRow | null = null;

    try {
      await sql.begin(async (tx) => {
        const completedPurchase = await storeRepo.markPurchaseCompletedInTx(
          tx,
          stripeCheckoutId,
          paymentIntentId
        );

        if (!completedPurchase) {
          const existingPurchase = await storeRepo.getPurchaseByStripeCheckoutIdInTx(
            tx,
            stripeCheckoutId
          );

          if (!existingPurchase) {
            throw new AppError(
              'Purchase not found for Stripe checkout id',
              500,
              ErrorCode.INTERNAL_ERROR,
              { stripeCheckoutId }
            );
          }

          if (existingPurchase.status === 'completed') {
            return;
          }

          throw new AppError(
            'Purchase is not in pending state',
            500,
            ErrorCode.INTERNAL_ERROR,
            { purchaseId: existingPurchase.id, status: existingPurchase.status }
          );
        }

        purchaseForFailure = completedPurchase;

        const product = await storeRepo.getProductByIdInTx(tx, completedPurchase.product_id);
        if (!product) {
          throw new AppError(
            'Purchase product not found',
            500,
            ErrorCode.INTERNAL_ERROR,
            { purchaseId: completedPurchase.id, productId: completedPurchase.product_id }
          );
        }

        let coinsDelta = 0;
        let ticketsDelta = 0;
        let inventoryDelta: Record<string, number> = {};

        switch (product.type) {
          case 'coin_pack': {
            const parsed = coinPackMetadataSchema.safeParse(product.metadata);
            if (!parsed.success) {
              throw new AppError(
                'Invalid coin pack metadata',
                500,
                ErrorCode.INTERNAL_ERROR,
                { productId: product.id, slug: product.slug }
              );
            }
            const metadata = parsed.data;
            coinsDelta = metadata.coins;
            const wallet = await storeRepo.addCoinsInTx(tx, completedPurchase.user_id, coinsDelta);
            if (!wallet) {
              throw new AppError(
                'Failed to apply coin fulfillment',
                500,
                ErrorCode.INTERNAL_ERROR,
                { purchaseId: completedPurchase.id, userId: completedPurchase.user_id }
              );
            }
            break;
          }
          case 'ticket_pack': {
            const parsed = ticketPackMetadataSchema.safeParse(product.metadata);
            if (!parsed.success) {
              throw new AppError(
                'Invalid ticket pack metadata',
                500,
                ErrorCode.INTERNAL_ERROR,
                { productId: product.id, slug: product.slug }
              );
            }
            const metadata = parsed.data;
            const ticketGrant = await ticketRefillService.clampTicketGrantInTx(
              tx,
              completedPurchase.user_id,
              metadata.tickets,
              { rejectOnOverflow: true }
            );
            ticketsDelta = ticketGrant.grantedTickets;
            break;
          }
          case 'avatar':
          case 'chance_card': {
            await storeRepo.upsertInventoryInTx(tx, completedPurchase.user_id, product.id, 1);
            inventoryDelta = { [product.slug]: 1 };
            break;
          }
          default:
            throw new AppError(
              'Unsupported product type during fulfillment',
              500,
              ErrorCode.INTERNAL_ERROR,
              { purchaseId: completedPurchase.id, productType: product.type }
            );
        }

        await storeRepo.insertTransactionLogInTx(tx, {
          eventType: 'fulfillment_succeeded',
          outcome: 'success',
          purchaseId: completedPurchase.id,
          userId: completedPurchase.user_id,
          productId: completedPurchase.product_id,
          stripeCheckoutId: stripeCheckoutId,
          stripePaymentIntent: paymentIntentId,
          coinsDelta,
          ticketsDelta,
          inventoryDelta,
          requestId: getRequestId(),
          metadata: {
            productSlug: product.slug,
            productType: product.type,
          } as unknown as Json,
        });
      });
    } catch (error) {
      const purchase = purchaseForFailure ?? await storeRepo.getPurchaseByStripeCheckoutId(stripeCheckoutId);

      await storeRepo.insertTransactionLog({
        eventType: 'fulfillment_failed',
        outcome: 'failure',
        purchaseId: purchase?.id ?? null,
        userId: purchase?.user_id ?? null,
        productId: purchase?.product_id ?? null,
        stripeCheckoutId,
        stripePaymentIntent: paymentIntentId,
        errorCode: getErrorCode(error),
        errorMessage: getErrorMessage(error),
        requestId: getRequestId(),
      });

      logger.error({ err: error, stripeCheckoutId }, 'Store fulfillment failed');
      throw error;
    }
  },

  async getWallet(userId: string): Promise<StoreWalletResponse> {
    const now = new Date();
    const sinceIso = ticketPurchaseWindowSinceIso(now);
    const [wallet, purchaseWindow] = await Promise.all([
      ticketRefillService.hydrateTickets(userId),
      storeRepo.getTicketPackPurchaseWindow(userId, sinceIso),
    ]);
    const cooldown = buildTicketPurchaseCooldown(purchaseWindow.ticketCount, now);
    return buildWalletResponse(wallet, cooldown);
  },

  async getRankedTicketWallets(userIds: string[]): Promise<Map<string, WalletRow>> {
    const wallets = await storeRepo.getWallets(userIds);
    return new Map([...wallets].map(([userId, wallet]) => {
      const hydrated = resolveHydratedTicketState(wallet);
      return [userId, {
        coins: wallet.coins,
        tickets: hydrated.tickets,
      }];
    }));
  },

  async consumeRankedTickets(
    userIds: string[]
  ): Promise<{ wallets: Record<string, StoreWalletResponse> } | null> {
    const dedupedUserIds = [...new Set(userIds)].sort((left, right) => left.localeCompare(right));
    if (dedupedUserIds.length === 0) {
      return { wallets: {} };
    }

    return sql.begin(async (tx) => {
      const wallets: Record<string, StoreWalletResponse> = {};
      const hydratedWallets: Record<string, StoreWalletResponse> = {};

      for (const userId of dedupedUserIds) {
        const wallet = await ticketRefillService.hydrateTicketsInTx(tx, userId);
        if (!wallet) {
          throw new NotFoundError('User not found');
        }
        hydratedWallets[userId] = buildWalletResponse(wallet, await loadTicketPurchaseCooldownInTx(tx, userId));
      }

      const insufficientUserIds = dedupedUserIds.filter((userId) => (hydratedWallets[userId]?.tickets ?? 0) < 1);
      if (insufficientUserIds.length > 0) {
        logger.info(
          {
            userIds: dedupedUserIds,
            insufficientUserIds,
            wallets: hydratedWallets,
          },
          'Ranked ticket consumption aborted before decrement: insufficient tickets'
        );
        return null;
      }

      for (const userId of dedupedUserIds) {
        const result = await ticketRefillService.consumeRankedTicketInTx(tx, userId);
        if (!result.wallet) {
          throw new NotFoundError('User not found');
        }
        if (!result.consumed) {
          throw new AppError(
            'Ranked ticket consumption failed after preflight',
            409,
            ErrorCode.CONFLICT,
            {
              userId,
              userIds: dedupedUserIds,
              preflightWallet: hydratedWallets[userId] ?? null,
            }
          );
        }
        wallets[userId] = buildWalletResponse(result.wallet, await loadTicketPurchaseCooldownInTx(tx, userId));
      }

      logger.info(
        {
          userIds: dedupedUserIds,
          wallets,
        },
        'Ranked tickets consumed'
      );
      return { wallets };
    });
  },

  async refundRankedTickets(
    userIds: string[]
  ): Promise<{ wallets: Record<string, StoreWalletResponse> }> {
    const dedupedUserIds = [...new Set(userIds)].sort((left, right) => left.localeCompare(right));
    if (dedupedUserIds.length === 0) {
      return { wallets: {} };
    }

    return sql.begin(async (tx) => {
      const wallets: Record<string, StoreWalletResponse> = {};

      for (const userId of dedupedUserIds) {
        const wallet = await ticketRefillService.hydrateTicketsForUpdateInTx(tx, userId);
        if (!wallet) {
          throw new NotFoundError('User not found');
        }

        const nextTickets = Math.min(MAX_TICKETS, wallet.tickets + 1);
        const nextAnchor = nextTickets >= MAX_TICKETS ? null : wallet.tickets_refill_started_at;
        const updated = await storeRepo.setTicketsStateInTx(tx, userId, nextTickets, nextAnchor);
        if (!updated) {
          throw new NotFoundError('User not found');
        }

        wallets[userId] = buildWalletResponse(updated, await loadTicketPurchaseCooldownInTx(tx, userId));
      }

      logger.info(
        {
          userIds: dedupedUserIds,
          wallets,
        },
        'Ranked tickets refunded'
      );
      return { wallets };
    });
  },

  async getInventory(userId: string): Promise<{ items: StoreInventoryItemResponse[] }> {
    const rows = await storeRepo.listInventoryWithProducts(userId);
    return {
      items: rows.map((row) => {
        return {
          inventoryId: row.inventory_id,
          productId: row.product_id,
          slug: row.product_slug,
          type: row.product_type,
          name: parseI18nField(row.product_name),
          description: parseI18nField(row.product_description),
          metadata: parseProductMetadataByType(
            row.product_type,
            row.product_metadata,
            { productId: row.product_id, slug: row.product_slug }
          ),
          quantity: row.quantity,
          acquiredAt: row.acquired_at,
        };
      }),
    };
  },

  async applyManualAdjustment(
    actorUserId: string,
    input: ManualAdjustmentInput
  ): Promise<ManualAdjustmentResult> {
    const coinsDelta = input.coinsDelta ?? 0;
    const ticketsDelta = input.ticketsDelta ?? 0;
    const inventoryGrants = input.inventoryGrants ?? [];

    if (input.idempotencyKey) {
      const existingLog = await storeRepo.findManualAdjustmentSuccessByIdempotencyKey(input.idempotencyKey);
      if (existingLog) {
        const parsed = manualAdjustmentLogMetadataSchema.safeParse(existingLog.metadata);
        if (parsed.success) {
          return {
            applied: false,
            wallet: parsed.data.walletAfter,
            inventoryApplied: parsed.data.inventoryApplied,
          };
        }

        const wallet = await this.getWallet(input.userId);
        return {
          applied: false,
          wallet,
          inventoryApplied: inventoryGrants,
        };
      }
    }

    try {
      const result = await sql.begin(async (tx) => {
        const adjustedWallet = await applyWalletAdjustmentInTx(tx, input.userId, {
          coinsDelta,
          ticketsDelta,
          rejectTicketOverflow: false,
          insufficientCoinsMessage: 'Manual adjustment would result in negative balance',
        });
        const walletAfter = adjustedWallet.wallet;
        const appliedTicketsDelta = adjustedWallet.appliedTicketsDelta;

        const appliedInventory: Array<{ productSlug: string; quantity: number }> = [];
        const inventoryDelta: Record<string, number> = {};

        for (const grant of inventoryGrants) {
          const product = await storeRepo.getProductBySlugInTx(tx, grant.productSlug);
          if (!product || !product.is_active) {
            throw new NotFoundError(`Store product not found: ${grant.productSlug}`);
          }

          if (product.type !== 'avatar' && product.type !== 'chance_card') {
            throw new BadRequestError(
              `Inventory grants only support avatar/chance_card products: ${grant.productSlug}`
            );
          }

          await storeRepo.upsertInventoryInTx(tx, input.userId, product.id, grant.quantity);
          appliedInventory.push({
            productSlug: product.slug,
            quantity: grant.quantity,
          });
          inventoryDelta[product.slug] = (inventoryDelta[product.slug] ?? 0) + grant.quantity;
        }

        await storeRepo.insertTransactionLogInTx(tx, {
          eventType: 'manual_adjustment_succeeded',
          outcome: 'success',
          userId: input.userId,
          actorUserId,
          coinsDelta,
          ticketsDelta: appliedTicketsDelta,
          inventoryDelta,
          reason: input.reason,
          requestId: getRequestId(),
          idempotencyKey: input.idempotencyKey ?? null,
          metadata: {
            walletAfter,
            inventoryApplied: appliedInventory,
          } as unknown as Json,
        });

        return {
          walletAfter,
          inventoryApplied: appliedInventory,
          appliedTicketsDelta,
        };
      });

      if (input.notify) {
        // Notify with the delta that was actually committed (a ticket grant may
        // be clamped by MAX_TICKETS), not the requested amount.
        await notifyWalletChange(input.userId, {
          coinsDelta,
          ticketsDelta: result.appliedTicketsDelta,
          reason: input.reason,
        });
      }

      return {
        applied: true,
        wallet: result.walletAfter,
        inventoryApplied: result.inventoryApplied,
      };
    } catch (error) {
      if (input.idempotencyKey && isPgUniqueViolation(error)) {
        const existingLog = await storeRepo.findManualAdjustmentSuccessByIdempotencyKey(
          input.idempotencyKey
        );
        if (existingLog) {
          const parsed = manualAdjustmentLogMetadataSchema.safeParse(existingLog.metadata);
          if (parsed.success) {
            return {
              applied: false,
              wallet: parsed.data.walletAfter,
              inventoryApplied: parsed.data.inventoryApplied,
            };
          }
        }
      }

      await storeRepo.insertTransactionLog({
        eventType: 'manual_adjustment_failed',
        outcome: 'failure',
        userId: input.userId,
        actorUserId,
        coinsDelta,
        ticketsDelta,
        reason: input.reason,
        errorCode: getErrorCode(error),
        errorMessage: getErrorMessage(error),
        requestId: getRequestId(),
        idempotencyKey: input.idempotencyKey ?? null,
        metadata: {
          inventoryRequested: inventoryGrants,
        } as unknown as Json,
      });

      throw error;
    }
  },

  /**
   * Admin: clear a user's rolling-window ticket-pack purchases (mark them
   * refunded) so the per-24h purchase cap no longer blocks them — i.e. let a
   * capped user buy again immediately. Audited in store_transaction_logs.
   */
  async resetTicketPurchaseWindow(
    actorUserId: string,
    userId: string,
    reason: string
  ): Promise<{ voided: number; wallet: StoreWalletResponse }> {
    const user = await usersRepo.getById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    const sinceIso = ticketPurchaseWindowSinceIso();

    const voided = await sql.begin(async (tx) => {
      const count = await storeRepo.refundRecentTicketPurchasesInTx(tx, userId, sinceIso);
      await storeRepo.insertTransactionLogInTx(tx, {
        eventType: 'admin_ticket_window_reset',
        outcome: 'success',
        userId,
        actorUserId,
        reason,
        requestId: getRequestId(),
        metadata: { voidedPurchases: count, sinceIso } as unknown as Json,
      });
      return count;
    });

    // The refund + audit already committed. Fetching the refreshed wallet runs
    // ticket-refill hydration, which has its own optimistic-concurrency retry
    // and can still raise CONFLICT under contention. Don't fail the (already
    // applied) reset over a display read — fall back to a plain wallet read.
    let wallet: StoreWalletResponse;
    try {
      wallet = await this.getWallet(userId);
    } catch (err) {
      logger.warn({ err, userId }, 'Ticket-window reset: wallet hydrate failed, using plain read');
      const cooldownNow = new Date();
      const sinceIsoForCooldown = ticketPurchaseWindowSinceIso(cooldownNow);
      const [plainWallet, purchaseWindow] = await Promise.all([
        storeRepo.getWallet(userId),
        storeRepo.getTicketPackPurchaseWindow(userId, sinceIsoForCooldown),
      ]);
      if (!plainWallet) {
        throw new NotFoundError('User not found');
      }
      wallet = buildWalletResponse(
        plainWallet,
        buildTicketPurchaseCooldown(purchaseWindow.ticketCount, cooldownNow)
      );
    }
    logger.info({ userId, actorUserId, voided }, 'Admin ticket purchase window reset');
    return { voided, wallet };
  },

  async listTransactions(query: ListStoreTransactionsQuery) {
    const result = await storeRepo.listTransactionLogs(query);
    return {
      items: result.items.map(toStoreTransactionLogResponse),
      page: query.page,
      limit: query.limit,
      total: result.total,
      totalPages: Math.ceil(result.total / query.limit),
    };
  },

  async applyDevSelfGrant(userId: string, input: DevGrantSelfBody): Promise<{ wallet: StoreWalletResponse }> {
    if (config.NODE_ENV !== 'local') {
      throw new NotFoundError('Not found');
    }

    const result = await this.applyManualAdjustment(userId, {
      userId,
      coinsDelta: input.coinsDelta,
      ticketsDelta: input.ticketsDelta,
      reason: 'dev_store_self_grant',
    });

    return { wallet: result.wallet };
  },

  async logWebhookReceived(payload: {
    stripeCheckoutId: string | null;
    eventId: string;
    eventType: string;
  }): Promise<void> {
    await storeRepo.insertTransactionLog({
      eventType: 'webhook_received',
      outcome: 'success',
      stripeCheckoutId: payload.stripeCheckoutId,
      reason: payload.eventType,
      requestId: getRequestId(),
      metadata: {
        eventId: payload.eventId,
        eventType: payload.eventType,
      } as unknown as Json,
    });
  },

  async logWebhookSignatureInvalid(details: { message: string }): Promise<void> {
    await storeRepo.insertTransactionLog({
      eventType: 'webhook_signature_invalid',
      outcome: 'failure',
      errorCode: ErrorCode.AUTHENTICATION_ERROR,
      errorMessage: details.message,
      requestId: getRequestId(),
    });
  },
};
