import '../../http/openapi/zod-init.js';
import { z } from 'zod';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  clueCardIdParamSchema,
  bulkUpdateStatusRequestSchema,
  importCommitRequestSchema,
  importCommitResponseSchema,
  importPreviewRequestSchema,
  importPreviewResponseSchema,
  playerClueCardDetailSchema,
  updateStatusRequestSchema,
} from './player-clue-cards.schemas.js';

export function registerPlayerClueCardsOpenApi(registry: OpenAPIRegistry): void {
  const previewResponse = importPreviewResponseSchema.openapi('PlayerClueCardPreviewResponse');
  const commitResponse = importCommitResponseSchema.openapi('PlayerClueCardCommitResponse');
  const cardDetail = playerClueCardDetailSchema.openapi('PlayerClueCardDetail');

  registry.register('PlayerClueCardPreviewResponse', previewResponse);
  registry.register('PlayerClueCardCommitResponse', commitResponse);
  registry.register('PlayerClueCardDetail', cardDetail);

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/player-clue-cards/import/preview',
    summary: 'Preview parsed player clue card import (no DB writes)',
    tags: ['PlayerClueCards'],
    security: [{ bearerAuth: [] }],
    body: importPreviewRequestSchema,
    responses: {
      200: { description: 'Parsed preview with match results', schema: previewResponse },
      400: { description: 'Invalid input', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/player-clue-cards/import/commit',
    summary: 'Commit player clue card import rows as needs_review or approved',
    tags: ['PlayerClueCards'],
    security: [{ bearerAuth: [] }],
    body: importCommitRequestSchema,
    responses: {
      200: { description: 'Commit result with per-row status', schema: commitResponse },
      400: { description: 'Invalid input', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'patch',
    path: '/api/v1/admin/player-clue-cards/{id}/status',
    summary: 'Update player clue card status (approve, publish, reject)',
    tags: ['PlayerClueCards'],
    security: [{ bearerAuth: [] }],
    pathParams: clueCardIdParamSchema,
    body: updateStatusRequestSchema,
    responses: {
      200: { description: 'Updated player clue card', schema: cardDetail },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
      404: { description: 'Card not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'patch',
    path: '/api/v1/admin/player-clue-cards/status/bulk',
    summary: 'Bulk update player clue card status (approve, publish, reject)',
    tags: ['PlayerClueCards'],
    security: [{ bearerAuth: [] }],
    body: bulkUpdateStatusRequestSchema,
    responses: {
      200: { description: 'Number of updated cards', schema: z.object({ updated: z.number() }) },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
    },
  });
}
