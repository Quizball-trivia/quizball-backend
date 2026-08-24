import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  auctionPipelinePromptKeyParamSchema,
  auctionPipelinePromptSchema,
  auctionPipelinePromptUpdateSchema,
  auctionPipelinePromptsResponseSchema,
  auctionPipelineRequeueResponseSchema,
  auctionPipelineRequeueSchema,
  auctionPipelinePromptResetResponseSchema,
  auctionPipelineStatsResponseSchema,
  auctionPipelineWorkersResponseSchema,
} from './auction-pipeline.schemas.js';

export function registerAuctionPipelineOpenApi(registry: OpenAPIRegistry): void {
  const statsResponse = auctionPipelineStatsResponseSchema.openapi('AuctionPipelineStatsResponse');
  const workersResponse = auctionPipelineWorkersResponseSchema.openapi(
    'AuctionPipelineWorkersResponse'
  );
  const promptsResponse = auctionPipelinePromptsResponseSchema.openapi(
    'AuctionPipelinePromptsResponse'
  );
  const promptDetail = auctionPipelinePromptSchema.openapi('AuctionPipelinePrompt');
  const requeueResponse = auctionPipelineRequeueResponseSchema.openapi(
    'AuctionPipelineRequeueResponse'
  );
  const promptResetResponse = auctionPipelinePromptResetResponseSchema.openapi(
    'AuctionPipelinePromptResetResponse'
  );

  registry.register('AuctionPipelineStatsResponse', statsResponse);
  registry.register('AuctionPipelineWorkersResponse', workersResponse);
  registry.register('AuctionPipelinePromptsResponse', promptsResponse);
  registry.register('AuctionPipelinePrompt', promptDetail);
  registry.register('AuctionPipelineRequeueResponse', requeueResponse);
  registry.register('AuctionPipelinePromptResetResponse', promptResetResponse);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/auction-pipeline/stats',
    summary: 'Auction card generation pipeline status counters',
    tags: ['Auction'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Pipeline stage, attempt and coverage counters', schema: statsResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/auction-pipeline/workers',
    summary: 'Live card generation worker heartbeats',
    tags: ['Auction'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Workers with stale flags', schema: workersResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/auction-pipeline/prompts',
    summary: 'Operator prompt overrides for the card pipeline',
    tags: ['Auction'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Stored prompt overrides', schema: promptsResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'put',
    path: '/api/v1/admin/auction-pipeline/prompts/{key}',
    summary: 'Create or replace a card pipeline prompt override',
    tags: ['Auction'],
    security: [{ bearerAuth: [] }],
    pathParams: auctionPipelinePromptKeyParamSchema,
    body: auctionPipelinePromptUpdateSchema,
    responses: {
      200: { description: 'Stored prompt override', schema: promptDetail },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
      422: { description: 'Invalid prompt key or text', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'delete',
    path: '/api/v1/admin/auction-pipeline/prompts/{key}',
    summary: 'Reset a prompt override so the built-in rules apply again',
    tags: ['Auction'],
    security: [{ bearerAuth: [] }],
    pathParams: auctionPipelinePromptKeyParamSchema,
    responses: {
      200: { description: 'Whether an override was removed', schema: promptResetResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
      422: { description: 'Invalid prompt key', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/auction-pipeline/requeue',
    summary: 'Reset rejected or failed generation tasks back to queued',
    tags: ['Auction'],
    security: [{ bearerAuth: [] }],
    body: auctionPipelineRequeueSchema,
    responses: {
      200: { description: 'Number of tasks requeued', schema: requeueResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
      422: { description: 'Invalid requeue selector', schema: errorResponseSchema },
    },
  });
}
