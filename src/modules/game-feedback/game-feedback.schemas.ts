import { z } from 'zod';

export const gameFeedbackSchema = z.object({
  mode: z.enum(['solo', 'room']),
  rating: z.number().int().min(1).max(5),
  wantsOnline: z.boolean().nullable(),
  // An empty comment is no comment.
  comment: z.string().trim().max(500).optional().transform((text) => text || undefined),
  locale: z.enum(['en', 'ka', 'es', 'tr', 'ru', 'pt']),
}).strict();
export type GameFeedbackBody = z.infer<typeof gameFeedbackSchema>;
