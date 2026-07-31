import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  wlCheckinResponseSchema,
  wlCurrentResponseSchema,
  wlEnterResponseSchema,
  wlQpResponseSchema,
} from './weekend-league.schemas.js';

export function registerWeekendLeagueOpenApi(registry: OpenAPIRegistry): void {
  const currentResponse = wlCurrentResponseSchema.openapi('WlCurrentResponse');
  const qpResponse = wlQpResponseSchema.openapi('WlQpResponse');
  const enterResponse = wlEnterResponseSchema.openapi('WlEnterResponse');
  const checkinResponse = wlCheckinResponseSchema.openapi('WlCheckinResponse');
  registry.register('WlCurrentResponse', currentResponse);
  registry.register('WlQpResponse', qpResponse);
  registry.register('WlEnterResponse', enterResponse);
  registry.register('WlCheckinResponse', checkinResponse);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/weekend-league/current',
    summary: 'Current Weekend League tournament + the caller\'s standing',
    tags: ['WeekendLeague'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Tournament phase, timestamps, counts, entry and QP', schema: currentResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/weekend-league/qp',
    summary: 'Caller\'s qualification points for the active week',
    tags: ['WeekendLeague'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'QP total, W/L and qualification state', schema: qpResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/weekend-league/enter',
    summary: 'Claim entry into the open tournament',
    tags: ['WeekendLeague'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Entry outcome (idempotent)', schema: enterResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/weekend-league/checkin',
    summary: 'Check in during the pre-kickoff window (Saturday or final)',
    tags: ['WeekendLeague'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Check-in outcome (idempotent)', schema: checkinResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });
}
