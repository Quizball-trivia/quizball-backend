import { z } from 'zod';

export const CAMPAIGN_ATTRIBUTION_HEADER = 'x-quizball-campaign-attribution';

const campaignAttributionSchema = z.object({
  source: z.literal('campaign_quiz'),
  quiz_slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  cta_placement: z.enum(['header', 'score', 'footer', 'rating', 'hero']),
  captured_at: z.string().datetime(),
  campaign_conversion_id: z.string().uuid(),
  quiz_score: z.number().int().min(0).max(1000).optional(),
  quiz_total_questions: z.number().int().min(1).max(1000).optional(),
}).superRefine((value, ctx) => {
  if (
    value.quiz_score !== undefined &&
    value.quiz_total_questions !== undefined &&
    value.quiz_score > value.quiz_total_questions
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['quiz_score'],
      message: 'Quiz score cannot exceed total questions',
    });
  }
});

export type CampaignAttribution = z.infer<typeof campaignAttributionSchema>;

const MAX_ENCODED_LENGTH = 2048;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Decode the compact, analytics-only campaign payload sent by the web client.
 * The value is untrusted: strict validation and a short lifetime keep malformed
 * or stale data out of account-creation analytics. It is never used for auth or
 * authorization decisions.
 */
export function parseCampaignAttribution(
  raw: string | string[] | undefined,
  nowMs = Date.now(),
): CampaignAttribution | null {
  const encoded = Array.isArray(raw) ? raw[0] : raw;
  if (!encoded || encoded.length > MAX_ENCODED_LENGTH) return null;

  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = campaignAttributionSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;

    const capturedAtMs = Date.parse(parsed.data.captured_at);
    if (
      !Number.isFinite(capturedAtMs) ||
      capturedAtMs < nowMs - MAX_AGE_MS ||
      capturedAtMs > nowMs + MAX_FUTURE_SKEW_MS
    ) {
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
}

export function campaignAttributionProperties(
  attribution: CampaignAttribution,
): Record<string, string | number> {
  const properties: Record<string, string | number> = {
    source: attribution.source,
    quiz_type: 'campaign',
    quiz_slug: attribution.quiz_slug,
    cta_placement: attribution.cta_placement,
    campaign_captured_at: attribution.captured_at,
    campaign_conversion_id: attribution.campaign_conversion_id,
  };

  if (attribution.quiz_score !== undefined) {
    properties.quiz_score = attribution.quiz_score;
  }
  if (attribution.quiz_total_questions !== undefined) {
    properties.quiz_total_questions = attribution.quiz_total_questions;
  }
  if (
    attribution.quiz_score !== undefined &&
    attribution.quiz_total_questions !== undefined
  ) {
    properties.quiz_score_percent = Math.round(
      (attribution.quiz_score / attribution.quiz_total_questions) * 100,
    );
  }

  return properties;
}
