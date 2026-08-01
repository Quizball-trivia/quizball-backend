import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  wlCheckinResponseSchema,
  wlCurrentResponseSchema,
  wlEnterResponseSchema,
  wlQpResponseSchema,
} from './weekend-league.schemas.js';
import { wlCreateTestSchema } from './wl-ops.service.js';

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
    summary: 'Caller\'s QP running balance (resets when a ticket is claimed)',
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

  // ── Admin (CMS) surface — bearer admin role ──────────────────────────────
  const adminTournamentRow = z.object({}).catchall(z.unknown()).openapi('WlAdminTournamentRow');
  const adminList = z.object({ tournaments: z.array(adminTournamentRow) }).openapi('WlAdminTournamentsResponse');
  const adminDetail = z.object({
    tournament: adminTournamentRow,
    entry_states: z.array(z.object({ state: z.string(), n: z.number().int(), bots: z.number().int() })),
    current_game_index: z.number().int(),
    board: z.array(z.object({
      user_id: z.string(), points: z.number().int(), time_ms_total: z.number(),
      rank: z.number().int(), nickname: z.string().nullable(), is_ai: z.boolean().nullable(),
    })),
    game_results: z.array(z.object({}).catchall(z.unknown())),
    awards: z.array(z.object({}).catchall(z.unknown())),
    stream: z.object({
      head: z.number().int().nullable(), pending: z.number().int(), poisonish: z.number().int(),
    }).nullable(),
  }).openapi('WlAdminTournamentDetailResponse');
  registry.register('WlAdminTournamentsResponse', adminList);
  registry.register('WlAdminTournamentDetailResponse', adminDetail);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/wl/tournaments',
    summary: 'Recent WL tournaments with live counts (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Tournament list', schema: adminList },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
    },
  });
  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/wl/tournaments/{id}',
    summary: 'One WL tournament: field, standings, awards, stream health (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: { description: 'Tournament detail', schema: adminDetail },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'Not found', schema: errorResponseSchema },
    },
  });
  const okFlag = (key: string, name: string) =>
    z.object({ [key]: z.boolean() }).openapi(name);
  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/wl/create-test',
    summary: 'Create a compressed/any-date TEST tournament (admin, non-prod)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    body: wlCreateTestSchema.omit({ actor: true }).partial(),
    responses: {
      200: {
        description: 'Created',
        schema: z.object({ tournament_id: z.string().uuid() }).openapi('WlAdminCreateTestResponse'),
      },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });
  for (const [action, key] of [
    ['pause', 'paused'], ['resume', 'resumed'], ['cancel', 'cancelled'],
  ] as const) {
    registerEndpoint(registry, {
      method: 'post',
      path: `/api/v1/admin/wl/tournaments/{id}/${action}`,
      summary: `${action} a WL tournament (admin)`,
      tags: ['WeekendLeagueAdmin'],
      security: [{ bearerAuth: [] }],
      pathParams: z.object({ id: z.string().uuid() }),
      responses: {
        200: { description: 'Outcome', schema: okFlag(key, `WlAdmin${action[0]!.toUpperCase()}${action.slice(1)}Response`) },
        401: { description: 'Not authenticated', schema: errorResponseSchema },
      },
    });
  }
  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/wl/tournaments/{id}/fill-bots',
    summary: 'Top the field up with roster bots (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    pathParams: z.object({ id: z.string().uuid() }),
    body: z.object({ min_field: z.number().int().min(1) }),
    responses: {
      200: {
        description: 'Bots entered',
        schema: z.object({ filled: z.number().int() }).openapi('WlAdminFillBotsResponse'),
      },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });
  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/wl/force-tick',
    summary: 'Run one locked orchestrator tick now (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Tick outcome',
        schema: z.object({ ticked: z.boolean() }).openapi('WlAdminForceTickResponse'),
      },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });
}
