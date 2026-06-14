import { z } from 'zod';

/** What kind of message the player is sending. Drives the email subject prefix. */
export const feedbackCategorySchema = z.enum(['bug', 'feedback', 'other']);

export type FeedbackCategory = z.infer<typeof feedbackCategorySchema>;

// A single attachment as a base64 data URL (data:<mime>;base64,<data>). We use
// data URLs (not multipart) to match the existing no-multipart upload pattern.
// Size is bounded both here (string length) and again after decoding.
const MAX_ATTACHMENTS = 3;
const attachmentDataUrlSchema = z
  .string()
  .regex(/^data:(image\/(png|jpe?g|webp|gif)|video\/(mp4|webm|quicktime));base64,/, {
    message: 'Attachment must be a base64 image or video data URL',
  })
  // ~70MB of base64 ≈ ~50MB binary; a generous ceiling, re-checked after decode.
  .max(70 * 1024 * 1024);

export const submitFeedbackBodySchema = z.object({
  category: feedbackCategorySchema,
  message: z.string().trim().min(1, 'Message is required').max(4000),
  // Optional so logged-out visitors can submit; if provided we include it as a
  // reply-to so the team can respond.
  email: z.string().trim().email().max(254).optional().or(z.literal('')),
  // The reporter's in-game nickname (or typed name when logged out).
  nickname: z.string().trim().max(80).optional(),
  // Optional free-form context (page/route, app version) the client may attach.
  context: z.string().trim().max(500).optional(),
  // Optional screenshots / short video as base64 data URLs.
  attachments: z.array(attachmentDataUrlSchema).max(MAX_ATTACHMENTS).optional(),
});

export type SubmitFeedbackBody = z.infer<typeof submitFeedbackBodySchema>;

export const submitFeedbackResponseSchema = z.object({
  ok: z.boolean(),
});

export type SubmitFeedbackResponse = z.infer<typeof submitFeedbackResponseSchema>;
