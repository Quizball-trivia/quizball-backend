import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  listNotificationsQuerySchema,
  listNotificationsResponseSchema,
  notificationIdParamSchema,
  unreadCountResponseSchema,
} from './notifications.schemas.js';

export function registerNotificationsOpenApi(registry: OpenAPIRegistry): void {
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
