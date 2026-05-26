import { z } from 'zod';

export const translationDomainSchema = z.enum(['general', 'legal', 'marketing', 'ui']);

export const translateItemSchema = z.object({
  id: z.string().min(1).max(200),
  text: z.string().min(1).max(20_000),
});

export const translateRequestSchema = z.object({
  target_locale: z.string().min(2).max(10),
  source_locale: z.string().min(2).max(10).optional(),
  domain: translationDomainSchema.optional().default('general'),
  items: z.array(translateItemSchema).min(1).max(50),
});

export type TranslateRequestBody = z.infer<typeof translateRequestSchema>;

export const translateResponseSchema = z.object({
  translations: z.array(translateItemSchema),
});

export type TranslateResponseBody = z.infer<typeof translateResponseSchema>;
