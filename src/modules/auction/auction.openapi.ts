import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  auctionCardDetailSchema,
  auctionCardIdParamSchema,
  auctionCardSummarySchema,
  listAuctionCardsQuerySchema,
  paginatedAuctionCardsResponseSchema,
  updateAuctionCardSchema,
  updateAuctionCardStatusSchema,
} from './auction.schemas.js';

export function registerAuctionOpenApi(registry: OpenAPIRegistry): void {
  const cardSummary = auctionCardSummarySchema.openapi('AuctionCardSummary');
  const cardDetail = auctionCardDetailSchema.openapi('AuctionCardDetail');
  const paginatedCards = paginatedAuctionCardsResponseSchema.openapi('PaginatedAuctionCardsResponse');

  registry.register('AuctionCardSummary', cardSummary);
  registry.register('AuctionCardDetail', cardDetail);
  registry.register('PaginatedAuctionCardsResponse', paginatedCards);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/auction/cards',
    summary: 'List Auction cards for CMS review',
    tags: ['Auction'],
    security: [{ bearerAuth: [] }],
    query: listAuctionCardsQuerySchema,
    responses: {
      200: { description: 'Paginated Auction card summaries', schema: paginatedCards },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/auction/cards/{id}',
    summary: 'Get Auction card detail for CMS review',
    tags: ['Auction'],
    security: [{ bearerAuth: [] }],
    pathParams: auctionCardIdParamSchema,
    responses: {
      200: { description: 'Auction card detail', schema: cardDetail },
      400: { description: 'Invalid card id', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
      404: { description: 'Auction card not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'patch',
    path: '/api/v1/admin/auction/cards/{id}',
    summary: 'Update editable Auction card fields and clues',
    tags: ['Auction'],
    security: [{ bearerAuth: [] }],
    pathParams: auctionCardIdParamSchema,
    body: updateAuctionCardSchema,
    responses: {
      200: { description: 'Updated Auction card detail', schema: cardDetail },
      400: { description: 'Invalid card content', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
      404: { description: 'Auction card not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'patch',
    path: '/api/v1/admin/auction/cards/{id}/status',
    summary: 'Update Auction card status',
    tags: ['Auction'],
    security: [{ bearerAuth: [] }],
    pathParams: auctionCardIdParamSchema,
    body: updateAuctionCardStatusSchema,
    responses: {
      200: { description: 'Updated Auction card detail', schema: cardDetail },
      400: { description: 'Card is not publishable', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
      404: { description: 'Auction card not found', schema: errorResponseSchema },
    },
  });
}
