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

// Reject a reversed publish window (start after end). Only enforced when both
// bounds are present non-null; an open-ended window is always valid.
function windowIsValid(v: {
  activeFrom?: string | null;
  activeTo?: string | null;
}): boolean {
  if (!v.activeFrom || !v.activeTo) return true;
  return new Date(v.activeFrom).getTime() <= new Date(v.activeTo).getTime();
}
const WINDOW_ERROR = {
  message: 'activeFrom must be before or equal to activeTo',
  path: ['activeTo'] as string[],
};

export const createAnnouncementBodySchema = z
  .object({
    title: i18nFieldSchema,
    body: i18nFieldSchema,
    type: announcementTypeSchema.optional().default('update'),
    isActive: z.boolean().optional().default(true),
    activeFrom: z.string().datetime().nullable().optional(),
    activeTo: z.string().datetime().nullable().optional(),
  })
  .refine(windowIsValid, WINDOW_ERROR);

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
  })
  .refine(windowIsValid, WINDOW_ERROR);

export type UpdateAnnouncementBody = z.infer<typeof updateAnnouncementBodySchema>;

export const announcementIdParamSchema = z.object({
  announcementId: z.string().uuid(),
});

export type AnnouncementIdParam = z.infer<typeof announcementIdParamSchema>;
