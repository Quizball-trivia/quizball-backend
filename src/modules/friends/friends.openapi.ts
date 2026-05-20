import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import {
  createFriendRequestBodySchema,
  createFriendRequestResponseSchema,
  friendActionResponseSchema,
  friendRequestIdParamSchema,
  friendRequestsResponseSchema,
  friendUserIdParamSchema,
  friendsResponseSchema,
} from './index.js';

export function registerFriendsOpenApi(registry: OpenAPIRegistry): void {
  registry.register('FriendsResponse', friendsResponseSchema);
  registry.register('FriendRequestsResponse', friendRequestsResponseSchema);
  registry.register('CreateFriendRequestResponse', createFriendRequestResponseSchema);
  registry.register('FriendActionResponse', friendActionResponseSchema);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/friends',
    summary: 'List accepted friends for the authenticated user',
    tags: ['Friends'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Friends list', schema: friendsResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/friends/requests',
    summary: 'List incoming and outgoing friend requests',
    tags: ['Friends'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Friend request lists', schema: friendRequestsResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/friends/requests',
    summary: 'Send a friend request',
    tags: ['Friends'],
    security: [{ bearerAuth: [] }],
    body: createFriendRequestBodySchema,
    responses: {
      201: { description: 'Friend request created', schema: createFriendRequestResponseSchema },
      400: { description: 'Bad request', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'Target user not found', schema: errorResponseSchema },
      409: { description: 'Friend request conflict', schema: errorResponseSchema },
      422: { description: 'Validation error', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/friends/requests/{requestId}/accept',
    summary: 'Accept a received friend request',
    tags: ['Friends'],
    security: [{ bearerAuth: [] }],
    pathParams: friendRequestIdParamSchema,
    responses: {
      200: { description: 'Friend request accepted', schema: friendActionResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'Friend request not found', schema: errorResponseSchema },
      422: { description: 'Validation error', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/friends/requests/{requestId}/decline',
    summary: 'Decline a received friend request',
    tags: ['Friends'],
    security: [{ bearerAuth: [] }],
    pathParams: friendRequestIdParamSchema,
    responses: {
      200: { description: 'Friend request declined', schema: friendActionResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'Friend request not found', schema: errorResponseSchema },
      422: { description: 'Validation error', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/friends/requests/{requestId}/cancel',
    summary: 'Cancel a sent friend request',
    tags: ['Friends'],
    security: [{ bearerAuth: [] }],
    pathParams: friendRequestIdParamSchema,
    responses: {
      200: { description: 'Friend request cancelled', schema: friendActionResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'Friend request not found', schema: errorResponseSchema },
      422: { description: 'Validation error', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'delete',
    path: '/api/v1/friends/{friendUserId}',
    summary: 'Remove an existing friend',
    tags: ['Friends'],
    security: [{ bearerAuth: [] }],
    pathParams: friendUserIdParamSchema,
    responses: {
      200: { description: 'Friend removed', schema: friendActionResponseSchema },
      400: { description: 'Bad request', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'Friendship not found', schema: errorResponseSchema },
      422: { description: 'Validation error', schema: errorResponseSchema },
    },
  });
}
