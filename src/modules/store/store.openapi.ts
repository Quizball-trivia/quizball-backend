import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  createCheckoutBodySchema,
  createCheckoutResponseSchema,
  devGrantSelfBodySchema,
  devGrantSelfResponseSchema,
  listStoreTransactionsQuerySchema,
  listStoreTransactionsResponseSchema,
  manualAdjustmentBodySchema,
  manualAdjustmentResponseSchema,
  purchaseWithCoinsBodySchema,
  purchaseWithCoinsResponseSchema,
  storeInventoryResponseSchema,
  storeProductsResponseSchema,
  storeTransactionLogResponseSchema,
  storeWalletResponseSchema,
} from './store.schemas.js';

export function registerStoreOpenApi(registry: OpenAPIRegistry): void {
  registry.register('StoreProductsResponse', storeProductsResponseSchema);
  registry.register('StoreWalletResponse', storeWalletResponseSchema);
  registry.register('StoreInventoryResponse', storeInventoryResponseSchema);
  registry.register('CreateCheckoutResponse', createCheckoutResponseSchema);
  registry.register('PurchaseWithCoinsResponse', purchaseWithCoinsResponseSchema);
  registry.register('ManualAdjustmentResponse', manualAdjustmentResponseSchema);
  registry.register('StoreTransactionLogResponse', storeTransactionLogResponseSchema);
  registry.register('ListStoreTransactionsResponse', listStoreTransactionsResponseSchema);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/store/products',
    summary: 'List active store products',
    tags: ['Store'],
    responses: {
      200: { description: 'Active store products', schema: storeProductsResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/store/checkout',
    summary: 'Create Stripe checkout session',
    tags: ['Store'],
    security: [{ bearerAuth: [] }],
    body: createCheckoutBodySchema,
    responses: {
      200: { description: 'Checkout URL created', schema: createCheckoutResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'Product not found', schema: errorResponseSchema },
      502: { description: 'Stripe checkout creation failed', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/store/purchase-coins',
    summary: 'Purchase non-coin-pack products with coin balance',
    tags: ['Store'],
    security: [{ bearerAuth: [] }],
    body: purchaseWithCoinsBodySchema,
    responses: {
      200: { description: 'Product purchased with coins', schema: purchaseWithCoinsResponseSchema },
      400: { description: 'Insufficient coins or invalid product type', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'Product not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/store/wallet',
    summary: 'Get authenticated wallet balances',
    tags: ['Store'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Wallet balances', schema: storeWalletResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/store/inventory',
    summary: 'Get authenticated user inventory',
    tags: ['Store'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'User inventory', schema: storeInventoryResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/store/dev/grant-self',
    summary: 'Development-only self wallet grant',
    description: 'Local development helper for quickly granting coins/tickets to the authenticated user.',
    tags: ['Store'],
    security: [{ bearerAuth: [] }],
    body: devGrantSelfBodySchema,
    responses: {
      200: { description: 'Updated wallet after grant', schema: devGrantSelfResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'Not available outside local environment', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/store/admin/adjustments',
    summary: 'Apply manual admin adjustment',
    description: 'Requires admin role',
    tags: ['Store Admin'],
    security: [{ bearerAuth: [] }],
    body: manualAdjustmentBodySchema,
    responses: {
      200: { description: 'Adjustment result', schema: manualAdjustmentResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions', schema: errorResponseSchema },
      400: { description: 'Invalid adjustment request', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/store/admin/transactions',
    summary: 'List store transaction logs',
    description: 'Requires admin role',
    tags: ['Store Admin'],
    security: [{ bearerAuth: [] }],
    query: listStoreTransactionsQuerySchema,
    responses: {
      200: { description: 'Paginated store transaction logs', schema: listStoreTransactionsResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions', schema: errorResponseSchema },
    },
  });
}
