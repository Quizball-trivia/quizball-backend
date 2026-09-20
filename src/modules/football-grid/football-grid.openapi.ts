import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  footballGridLeaderboardQuerySchema,
  footballGridLeaderboardResponseSchema,
  footballGridUserRankQuerySchema,
  footballGridUserRankResponseSchema,
} from './football-grid-leaderboard.schemas.js';

export function registerFootballGridOpenApi(registry: OpenAPIRegistry): void {
  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/football-grid/leaderboard',
    summary: 'List the Football Tic Tac Toe leaderboard',
    tags: ['Football Tic Tac Toe'],
    security: [{ bearerAuth: [] }],
    query: footballGridLeaderboardQuerySchema,
    responses: {
      200: { description: 'Football Tic Tac Toe leaderboard', schema: footballGridLeaderboardResponseSchema },
      400: { description: 'Invalid query parameters', schema: errorResponseSchema },
      401: { description: 'Authentication required', schema: errorResponseSchema },
      422: { description: 'Query validation failed', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/football-grid/leaderboard/me',
    summary: "Get the authenticated user's Football Tic Tac Toe rank",
    tags: ['Football Tic Tac Toe'],
    security: [{ bearerAuth: [] }],
    query: footballGridUserRankQuerySchema,
    responses: {
      200: { description: 'Rank information, or null when unranked', schema: footballGridUserRankResponseSchema },
      400: { description: 'Invalid query parameters', schema: errorResponseSchema },
      401: { description: 'Authentication required', schema: errorResponseSchema },
      422: { description: 'Query validation failed', schema: errorResponseSchema },
    },
  });
}
