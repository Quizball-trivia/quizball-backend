import { z } from 'zod';
import { i18nFieldSchema } from '../../http/schemas/shared.js';

/** Visual style discriminator for the news row (colour + icon on the client). */
export const announcementTypeSchema = z.enum(['update', 'info', 'event']);

export type AnnouncementType = z.infer<typeof announcementTypeSchema>;

export const announcementSchema = z.object({
  id: z.string().uuid(),
  title: i18nFieldSchema,
  body: i18nFieldSchema,
  type: announcementTypeSchema,
  isActive: z.boolean(),
  activeFrom: z.string().datetime().nullable(),
  activeTo: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Announcement = z.infer<typeof announcementSchema>;

export const listAnnouncementsResponseSchema = z.object({
  items: z.array(announcementSchema),
});

export type ListAnnouncementsResponse = z.infer<typeof listAnnouncementsResponseSchema>;

// ── Admin write schemas ──

export const createAnnouncementBodySchema = z.object({
  title: i18nFieldSchema,
  body: i18nFieldSchema,
  type: announcementTypeSchema.optional().default('update'),
  isActive: z.boolean().optional().default(true),
  activeFrom: z.string().datetime().nullable().optional(),
  activeTo: z.string().datetime().nullable().optional(),
});

export type CreateAnnouncementBody = z.infer<typeof createAnnouncementBodySchema>;

// Partial update — every field optional, at least one required.
export const updateAnnouncementBodySchema = z
  .object({
    title: i18nFieldSchema,
    body: i18nFieldSchema,
    type: announcementTypeSchema,
    isActive: z.boolean(),
    activeFrom: z.string().datetime().nullable(),
    activeTo: z.string().datetime().nullable(),
  })
  .partial()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one field is required',
  });

export type UpdateAnnouncementBody = z.infer<typeof updateAnnouncementBodySchema>;

export const announcementIdParamSchema = z.object({
  announcementId: z.string().uuid(),
});

export type AnnouncementIdParam = z.infer<typeof announcementIdParamSchema>;
