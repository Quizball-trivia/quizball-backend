import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { config } from '../../core/config.js';
import {
  createCheckoutBodySchema,
  purchaseWithCoinsBodySchema,
  devGrantSelfBodySchema,
  listStoreTransactionsQuerySchema,
  manualAdjustmentBodySchema,
  storeController,
} from '../../modules/store/index.js';

const router = Router();

/**
 * GET /api/v1/store/products
 * List active store products. Intentionally public (no auth) — catalog is visible to all.
 */
router.get('/products', storeController.listProducts);

/**
 * POST /api/v1/store/checkout
 * Create Stripe checkout session for selected product.
 */
router.post(
  '/checkout',
  authMiddleware,
  validate({ body: createCheckoutBodySchema }),
  storeController.createCheckout
);

/**
 * POST /api/v1/store/purchase-coins
 * Purchase ticket/avatar/chance-card products using coin balance.
 */
router.post(
  '/purchase-coins',
  authMiddleware,
  validate({ body: purchaseWithCoinsBodySchema }),
  storeController.purchaseWithCoins
);

/**
 * GET /api/v1/store/wallet
 * Get authenticated user's wallet balances.
 */
router.get('/wallet', authMiddleware, storeController.getWallet);

/**
 * GET /api/v1/store/inventory
 * Get authenticated user's owned store inventory.
 */
router.get('/inventory', authMiddleware, storeController.getInventory);

/**
 * POST /api/v1/store/dev/grant-self
 * Development-only helper to grant self wallet funds quickly.
 * Only registered in non-prod environments.
 */
if (config.NODE_ENV !== 'prod') {
  router.post(
    '/dev/grant-self',
    authMiddleware,
    validate({ body: devGrantSelfBodySchema }),
    storeController.createDevSelfGrant
  );
}

/**
 * POST /api/v1/store/admin/adjustments
 * Apply manual admin adjustments with idempotency support.
 */
router.post(
  '/admin/adjustments',
  authMiddleware,
  requireRole('admin'),
  validate({ body: manualAdjustmentBodySchema }),
  storeController.createManualAdjustment
);

/**
 * GET /api/v1/store/admin/transactions
 * List immutable store transaction logs for reconciliation.
 */
router.get(
  '/admin/transactions',
  authMiddleware,
  requireRole('admin'),
  validate({ query: listStoreTransactionsQuerySchema }),
  storeController.listTransactions
);

export const storeRoutes = router;
