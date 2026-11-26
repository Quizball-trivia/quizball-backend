import { z } from 'zod';

export const updateHarnessSettingsBodySchema = z
  .object({
    paused: z.boolean().optional(),
    pausedReason: z.string().trim().max(500).nullable().optional(),
    maxConcurrentRuns: z.number().int().min(0).max(50).optional(),
    dailyRunLimit: z.number().int().min(0).max(100_000).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'provide at least one field' });
export type UpdateHarnessSettingsBody = z.infer<typeof updateHarnessSettingsBodySchema>;

/** The policies the CMS may change, with the values each accepts. */
export const EDITABLE_POLICIES = {
  'classic.release_status': z.enum(['draft', 'published']),
  'classic.brief_size': z.number().int().min(1).max(50),
  'classic.max_open_briefs_per_category': z.number().int().min(1).max(20),
  'classic.max_new_briefs_per_tick': z.number().int().min(0).max(100),
  'classic.min_quality_score': z.number().min(0).max(10),
} as const;

export const policyKeyParamSchema = z.object({
  key: z.enum(Object.keys(EDITABLE_POLICIES) as [keyof typeof EDITABLE_POLICIES, ...Array<keyof typeof EDITABLE_POLICIES>]),
});
export type PolicyKeyParam = z.infer<typeof policyKeyParamSchema>;

export const setPolicyBodySchema = z.object({ value: z.unknown() });
export type SetPolicyBody = z.infer<typeof setPolicyBodySchema>;
