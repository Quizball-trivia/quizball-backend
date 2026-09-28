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
import {
  wlContentBatchDetailSchema,
  wlContentBatchSchema,
  wlContentCheckResponseSchema,
  wlContentCheckSchema,
  wlContentImportResponseSchema,
  wlContentImportSchema,
  wlContentReseedResponseSchema,
  wlContentScheduleResponseSchema,
  wlLineupEventSchema,
  wlLineupPreviewResponseSchema,
  wlLineupPreviewSchema,
  wlLineupSaveResponseSchema,
  wlLineupSaveSchema,
  wlContentRunwaySchema,
} from './wl-content.schemas.js';

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
    registrants: z.array(z.object({}).catchall(z.unknown())),
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
    method: 'get',
    path: '/api/v1/admin/wl/stock',
    summary: 'WL question-stock levels per kind and visibility (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Stock counts',
        schema: z.object({
          stock: z.array(z.object({ type: z.string(), visibility: z.string(), n: z.number().int() })),
        }).openapi('WlAdminStockResponse'),
      },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });
  // ── Editor content import (CMS) ─────────────────────────────────────────
  const contentCheckResponse = wlContentCheckResponseSchema.openapi('WlContentCheckResponse');
  const contentImportResponse = wlContentImportResponseSchema.openapi('WlContentImportResponse');
  const contentBatch = wlContentBatchSchema.openapi('WlContentBatch');
  const contentBatchDetail = wlContentBatchDetailSchema.openapi('WlContentBatchDetail');
  const contentRunway = wlContentRunwaySchema.openapi('WlContentRunway');
  const contentReseed = wlContentReseedResponseSchema.openapi('WlContentReseedResponse');
  const contentSchedule = wlContentScheduleResponseSchema.openapi('WlContentScheduleResponse');
  registry.register('WlContentCheckResponse', contentCheckResponse);
  registry.register('WlContentImportResponse', contentImportResponse);
  registry.register('WlContentBatch', contentBatch);
  registry.register('WlContentBatchDetail', contentBatchDetail);
  registry.register('WlContentRunway', contentRunway);
  registry.register('WlContentReseedResponse', contentReseed);
  registry.register('WlContentScheduleResponse', contentSchedule);
  const adminErrors = {
    401: { description: 'Not authenticated', schema: errorResponseSchema },
    403: { description: 'Not an admin', schema: errorResponseSchema },
  } as const;
  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/wl/content/check',
    summary: 'Validate + dedupe uploaded WL questions against the pool and every past event (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    body: wlContentCheckSchema,
    responses: { 200: { description: 'Per-row report', schema: contentCheckResponse }, ...adminErrors },
  });
  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/wl/content/import',
    summary: 'Publish uploaded WL questions into the protected pool as a batch (admin, async)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    body: wlContentImportSchema,
    responses: {
      202: { description: 'Batch accepted; poll the batch for progress', schema: contentImportResponse },
      400: { description: 'Rows blocked (errors / unforced duplicates)', schema: errorResponseSchema },
      ...adminErrors,
    },
  });
  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/wl/content/batches',
    summary: 'Recent WL content import batches (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Batches', schema: z.object({ batches: z.array(contentBatch) }).openapi('WlContentBatchesResponse') }, ...adminErrors },
  });
  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/wl/content/batches/{id}',
    summary: 'One WL content batch with per-row state (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    pathParams: z.object({ id: z.string().uuid() }),
    responses: { 200: { description: 'Batch detail', schema: contentBatchDetail }, 404: { description: 'Not found', schema: errorResponseSchema }, ...adminErrors },
  });
  registerEndpoint(registry, {
    method: 'delete',
    path: '/api/v1/admin/wl/content/batches/{id}',
    summary: 'Undo a WL content batch: delete its questions that were never dealt (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: {
        description: 'Undo outcome',
        schema: z.object({
          deleted: z.number().int(), kept: z.number().int(), kept_ids: z.array(z.string().uuid()), staging_deleted: z.number().int().nullable(),
          photos: z.object({ deleted: z.number().int(), shared: z.number().int(), error: z.string().nullable() }).nullable()
            .describe('Stored photos removed by this undo; null while the cleanup waits behind a running import'),
        }).openapi('WlContentUndoResponse'),
      },
      409: { description: 'Batch still processing', schema: errorResponseSchema },
      ...adminErrors,
    },
  });
  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/wl/content/batches/{id}/schedule',
    summary: 'Re-draw the coming WL event with this batch\'s questions first (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    pathParams: z.object({ id: z.string().uuid() }),
    body: z.object({ tournament_id: z.string().uuid().optional().describe('Event to re-draw; defaults to the coming one') }),
    responses: {
      200: { description: 'Schedule outcome', schema: contentSchedule },
      404: { description: 'Batch not found', schema: errorResponseSchema },
      409: { description: 'Batch not published, no coming event, or play has started', schema: errorResponseSchema },
      ...adminErrors,
    },
  });
  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/wl/content/runway',
    summary: 'Fresh editor inventory vs. drawable WL stock per round kind (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Runway', schema: contentRunway }, ...adminErrors },
  });
  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/wl/content/next-event',
    summary: 'Frozen content of the coming WL event, per game and round (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    query: z.object({ tournament_id: z.string().uuid().optional().describe('Event to show; defaults to the coming one') }),
    responses: { 200: { description: 'Next event content', schema: z.object({}).passthrough().openapi('WlContentNextEventResponse') }, ...adminErrors },
  });
  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/wl/content/lineup/events',
    summary: 'Weekends a lineup can be uploaded for, with lock reasons (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Events', schema: z.object({ events: z.array(wlLineupEventSchema) }).openapi('WlLineupEventsResponse') }, ...adminErrors },
  });
  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/wl/content/lineup/preview',
    summary: 'Validate a lineup upload and preview its exact placements; returns a preview id when it can be saved (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    body: wlLineupPreviewSchema,
    responses: { 200: { description: 'Preview', schema: wlLineupPreviewResponseSchema.openapi('WlLineupPreviewResponse') }, 404: { description: 'Weekend not found', schema: errorResponseSchema }, ...adminErrors },
  });
  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/wl/content/lineup/save',
    summary: 'Save a previewed lineup: publishes its questions and places them exactly as previewed, or nothing (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    body: wlLineupSaveSchema,
    responses: {
      202: { description: 'Saving started (poll the batch)', schema: wlLineupSaveResponseSchema.openapi('WlLineupSaveResponse') },
      404: { description: 'Preview not found', schema: errorResponseSchema },
      409: { description: 'Preview expired, weekend changed or locked', schema: errorResponseSchema },
      ...adminErrors,
    },
  });
  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/wl/content/tournaments/{id}/reseed',
    summary: 'Re-draw a not-yet-played tournament\'s content from the current pool (admin)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    pathParams: z.object({ id: z.string().uuid() }),
    responses: { 200: { description: 'Reseed outcome', schema: contentReseed }, 409: { description: 'Play started or wrong status', schema: errorResponseSchema }, ...adminErrors },
  });

  registerEndpoint(registry, {
    method: 'delete',
    path: '/api/v1/admin/wl/tournaments/{id}',
    summary: 'Delete a TEST tournament (real events must be cancelled instead)',
    tags: ['WeekendLeagueAdmin'],
    security: [{ bearerAuth: [] }],
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: {
        description: 'Deleted',
        schema: z.object({ deleted: z.boolean() }).openapi('WlAdminDeleteTestResponse'),
      },
      400: { description: 'Not a test event', schema: errorResponseSchema },
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
