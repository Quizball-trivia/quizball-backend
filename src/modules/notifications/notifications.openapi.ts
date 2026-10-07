import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { z } from 'zod';
import { registerPushDeviceSchema, unregisterPushDeviceSchema, pushPreferencesSchema,
  updatePushPreferencesSchema, pushCampaignSchema } from './mobile-push.schemas.js';
import {
  listNotificationsQuerySchema,
  listNotificationsResponseSchema,
  notificationIdParamSchema,
  unreadCountResponseSchema,
} from './notifications.schemas.js';

export function registerNotificationsOpenApi(registry: OpenAPIRegistry): void {
  const failures = {
    401: { description: 'Bearer authentication required', schema: errorResponseSchema },
    403: { description: 'Account or admin permission required', schema: errorResponseSchema },
    422: { description: 'Invalid request', schema: errorResponseSchema },
    429: { description: 'Request limit exceeded', schema: errorResponseSchema },
    503: { description: 'Push capability is not configured or enabled', schema: errorResponseSchema },
  };
  for (const endpoint of [
    { method: 'post' as const, path: 'devices/register', summary: 'Register this account’s native push device', body: registerPushDeviceSchema, code: 200,
      response: z.object({ registered: z.literal(true) }) },
    { method: 'post' as const, path: 'devices/unregister', summary: 'Unregister this account’s native push device', body: unregisterPushDeviceSchema, code: 200,
      response: z.object({ unregistered: z.literal(true) }) },
    { method: 'get' as const, path: 'preferences', summary: 'Read the account’s push consent and local reminder time', code: 200, response: pushPreferencesSchema },
    { method: 'patch' as const, path: 'preferences', summary: 'Update explicit push consent and reminder time', body: updatePushPreferencesSchema, code: 200, response: pushPreferencesSchema },
    { method: 'post' as const, path: 'devices/test', summary: 'Queue a notification only to the current account’s devices', code: 202, response: z.object({ queued: z.number().int() }) },
    { method: 'get' as const, path: 'campaigns/preview', summary: 'Admin: count eligible opted-in campaign recipients', code: 200,
      response: z.object({ users: z.number().int(), devices: z.number().int(), alreadyCapped:z.number().int() }) },
    { method: 'post' as const, path: 'campaigns/send', summary: 'Admin: explicitly queue an idempotent production campaign', body: pushCampaignSchema, code: 202,
      response: z.object({ queued: z.number().int(), duplicate: z.boolean() }) },
  ]) registerEndpoint(registry, { method: endpoint.method, path: `/api/v1/notifications/${endpoint.path}`,
    summary: endpoint.summary, tags: ['Notifications'], security: [{ bearerAuth: [] }], body: 'body' in endpoint ? endpoint.body : undefined,
    responses: { [endpoint.code]: { description: 'Push account state or queue result; a queue/ticket is not proof of delivery', schema: endpoint.response }, ...failures } });
  const listResponse = listNotificationsResponseSchema.openapi('ListNotificationsResponse');
  const unreadResponse = unreadCountResponseSchema.openapi('UnreadCountResponse');
  registry.register('ListNotificationsResponse', listResponse);
  registry.register('UnreadCountResponse', unreadResponse);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/notifications',
    summary: 'List the current user notifications',
    tags: ['Notifications'],
    security: [{ bearerAuth: [] }],
    query: listNotificationsQuerySchema,
    responses: {
      200: { description: 'Notification feed with unread count', schema: listResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/notifications/unread-count',
    summary: 'Get the current user unread notification count',
    tags: ['Notifications'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Unread count', schema: unreadResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/notifications/{notificationId}/read',
    summary: 'Mark a notification as read',
    tags: ['Notifications'],
    security: [{ bearerAuth: [] }],
    pathParams: notificationIdParamSchema,
    responses: {
      200: { description: 'Updated unread count', schema: unreadResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/notifications/read-all',
    summary: 'Mark all notifications as read',
    tags: ['Notifications'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Updated unread count (zero)', schema: unreadResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });
}
