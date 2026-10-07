import { createHash } from 'node:crypto';
import { z } from 'zod';

/** One partner environment per deploy (staging = test, production = production). */
const partnerConfigSchema = z.object({
  slug: z.literal('freecroco'),
  environment: z.enum(['test', 'production']),
  /** sha256 hex of each accepted inbound x-api-key (two during rotation). */
  inboundKeySha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(2),
  /** CIDRs allowed to call the machine endpoints; empty = allow none. */
  allowedCidrs: z.array(z.string()).default([]),
  /** Freecroco score-events endpoint and the key we send to it; absent until Freecroco provides them. */
  webhook: z.object({ url: z.string().url().startsWith('https://'), apiKey: z.string().min(16) }).optional(),
  /** Where launch links point, e.g. https://staging-freecroco.quizball.io */
  launchBaseUrl: z.string().url(),
});
export type PartnerConfig = z.infer<typeof partnerConfigSchema>;

let cached: PartnerConfig | null | undefined;

/** Parsed from PARTNER_FREECROCO_CONFIG (JSON). Null when the partner is not configured on this deploy. */
export function getFreecrocoConfig(): PartnerConfig | null {
  if (cached !== undefined) return cached;
  const raw = process.env.PARTNER_FREECROCO_CONFIG;
  cached = raw ? partnerConfigSchema.parse(JSON.parse(raw)) : null;
  return cached;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Test hook only. */
export function resetPartnerConfigCache(): void {
  cached = undefined;
}
