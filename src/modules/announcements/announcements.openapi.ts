import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  announcementSchema,
  createAnnouncementBodySchema,
  updateAnnouncementBodySchema,
  announcementIdParamSchema,
  listAnnouncementsResponseSchema,
} from './announcements.schemas.js';

export function registerAnnouncementsOpenApi(registry: OpenAPIRegistry): void {
  const announcement = announcementSchema.openapi('Announcement');
  const listResponse = listAnnouncementsResponseSchema.openapi('ListAnnouncementsResponse');
  registry.register('Announcement', announcement);
  registry.register('ListAnnouncementsResponse', listResponse);

  // ── Public ──
  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/announcements',
    summary: 'List active announcements (player News feed)',
    tags: ['Announcements'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Active announcements, newest first', schema: listResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  // ── Admin ──
  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/admin/announcements',
    summary: 'List all announcements (admin)',
    tags: ['Announcements'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'All announcements, newest first', schema: listResponse },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/admin/announcements',
    summary: 'Create an announcement (admin)',
    tags: ['Announcements'],
    security: [{ bearerAuth: [] }],
    body: createAnnouncementBodySchema,
    responses: {
      201: { description: 'Created announcement', schema: announcement },
      400: { description: 'Invalid input', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'patch',
    path: '/api/v1/admin/announcements/{announcementId}',
    summary: 'Update an announcement (admin)',
    tags: ['Announcements'],
    security: [{ bearerAuth: [] }],
    pathParams: announcementIdParamSchema,
    body: updateAnnouncementBodySchema,
    responses: {
      200: { description: 'Updated announcement', schema: announcement },
      400: { description: 'Invalid input', schema: errorResponseSchema },
      403: { description: 'Not an admin', schema: errorResponseSchema },
      404: { description: 'Not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'delete',
    path: '/api/v1/admin/announcements/{announcementId}',
    summary: 'Delete an announcement (admin)',
    tags: ['Announcements'],
    security: [{ bearerAuth: [] }],
    pathParams: announcementIdParamSchema,
    responses: {
      204: { description: 'Deleted' },
      403: { description: 'Not an admin', schema: errorResponseSchema },
      404: { description: 'Not found', schema: errorResponseSchema },
    },
  });
}
