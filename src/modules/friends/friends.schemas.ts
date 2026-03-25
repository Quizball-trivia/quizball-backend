import { z } from 'zod';

export const friendStatusSchema = z.enum([
  'none',
  'pending_sent',
  'pending_received',
  'friends',
]);

export const friendRequestStatusSchema = z.enum([
  'pending',
  'accepted',
  'declined',
  'cancelled',
]);

export const socialPlayerSummarySchema = z.object({
  id: z.string().uuid(),
  nickname: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  rp: z.number().int().nonnegative(),
  level: z.number().int().positive(),
  friendStatus: friendStatusSchema,
});

export const friendRequestUserSchema = socialPlayerSummarySchema.extend({
  friendStatus: z.enum(['pending_sent', 'pending_received']),
});

export const friendsResponseSchema = z.object({
  friends: z.array(
    socialPlayerSummarySchema.extend({
      friendStatus: z.literal('friends'),
    })
  ),
});

export const friendRequestItemSchema = z.object({
  requestId: z.string().uuid(),
  createdAt: z.string().datetime(),
  user: friendRequestUserSchema,
});

export const friendRequestsResponseSchema = z.object({
  incoming: z.array(friendRequestItemSchema),
  outgoing: z.array(friendRequestItemSchema),
  incomingCount: z.number().int().nonnegative(),
});

export const createFriendRequestBodySchema = z.object({
  targetUserId: z.string().uuid(),
});

export const createFriendRequestResponseSchema = z.object({
  requestId: z.string().uuid(),
  status: z.literal('pending'),
});

export const friendRequestIdParamSchema = z.object({
  requestId: z.string().uuid(),
});

export const friendUserIdParamSchema = z.object({
  friendUserId: z.string().uuid(),
});

export const friendActionResponseSchema = z.object({
  success: z.literal(true),
});

export type FriendStatus = z.infer<typeof friendStatusSchema>;
export type FriendRequestStatus = z.infer<typeof friendRequestStatusSchema>;
export type CreateFriendRequestBody = z.infer<typeof createFriendRequestBodySchema>;
export type FriendRequestIdParam = z.infer<typeof friendRequestIdParamSchema>;
export type FriendUserIdParam = z.infer<typeof friendUserIdParamSchema>;
