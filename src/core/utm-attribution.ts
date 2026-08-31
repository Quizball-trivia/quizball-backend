import { z } from 'zod';

/**
 * Generic UTM attribution for signups.
 *
 * `account_created` is emitted server-side (gated on the DB insert), so it has
 * no access to the browser's URL params — historically leaving every paid /
 * social campaign unattributable at the conversion step. PostHog's person-level
 * `$initial_utm_*` cannot cover the gap either: the web client runs
 * `person_profiles: 'identified_only'`, so anonymous visitors have no person
 * profile to carry those properties.
 *
 * The client therefore forwards the first-touch UTM triplet it captured (stored
 * for 30 days) on the auth bootstrap request, exactly like the campaign-quiz
 * attribution header. Analytics-only, never used for auth decisions.
 */
export const UTM_ATTRIBUTION_HEADER = 'x-quizball-utm';

// Deliberately narrow: the three fields that identify a campaign. Values are
// untrusted, so they are length-capped and character-restricted to keep
// malformed or injected data out of analytics properties.
const utmValue = z.string().min(1).max(64).regex(/^[A-Za-z0-9._\-|]+$/);

const utmAttributionSchema = z.object({
  utm_source: utmValue,
  utm_medium: utmValue.optional(),
  utm_campaign: utmValue.optional(),
  captured_at: z.string().datetime(),
}).strict();

export type UtmAttribution = z.infer<typeof utmAttributionSchema>;

const MAX_ENCODED_LENGTH = 512;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Decode the base64url JSON payload sent by the web client. Returns null for
 * anything missing, oversized, malformed, stale (>30d) or clock-skewed into the
 * future — a bad header must never break account creation.
 */
export function parseUtmAttribution(
  raw: string | string[] | undefined,
  nowMs: number = Date.now(),
): UtmAttribution | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > MAX_ENCODED_LENGTH) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const parsed = utmAttributionSchema.safeParse(decoded);
  if (!parsed.success) return null;

  const capturedAtMs = Date.parse(parsed.data.captured_at);
  if (!Number.isFinite(capturedAtMs)) return null;
  if (capturedAtMs > nowMs + MAX_FUTURE_SKEW_MS) return null;
  if (nowMs - capturedAtMs > MAX_AGE_MS) return null;

  return parsed.data;
}

/** Flatten onto an analytics event. Prefixed-free names match PostHog's own
 *  `utm_*` convention so campaign breakdowns work without extra mapping. */
export function utmAttributionProperties(
  attribution: UtmAttribution,
): Record<string, string> {
  const properties: Record<string, string> = {
    utm_source: attribution.utm_source,
    utm_captured_at: attribution.captured_at,
  };
  if (attribution.utm_medium) properties.utm_medium = attribution.utm_medium;
  if (attribution.utm_campaign) properties.utm_campaign = attribution.utm_campaign;
  return properties;
}
