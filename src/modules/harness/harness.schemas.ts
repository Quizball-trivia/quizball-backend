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

// ── steering (any active HQ team member) ────────────────────────────────────

export const STEERING_PRIORITIES = ['boost', 'normal', 'hold'] as const;

export const categoryParamSchema = z.object({ categoryId: z.string().uuid() });
export type CategoryParam = z.infer<typeof categoryParamSchema>;

export const setSteeringBodySchema = z
  .object({ priority: z.enum(STEERING_PRIORITIES).optional(), direction: z.string().trim().max(1000).optional() })
  .refine((b) => b.priority !== undefined || b.direction !== undefined, { message: 'provide priority or direction' });
export type SetSteeringBody = z.infer<typeof setSteeringBodySchema>;

export const setDirectionBodySchema = z.object({ direction: z.string().trim().max(1000) });
export type SetDirectionBody = z.infer<typeof setDirectionBodySchema>;

export const createRequestBodySchema = z.object({
  categoryId: z.string().uuid(),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  count: z.number().int().min(1).max(50),
  topic: z.string().trim().min(3).max(300),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
export type CreateRequestBody = z.infer<typeof createRequestBodySchema>;

export const briefParamSchema = z.object({ briefId: z.string().uuid() });
export type BriefParam = z.infer<typeof briefParamSchema>;

export const itemParamSchema = z.object({ itemId: z.string().uuid() });
export type ItemParam = z.infer<typeof itemParamSchema>;

export const itemActionBodySchema = z
  .object({
    action: z.enum(['flag', 'approve', 'reject', 'send_back']),
    version: z.number().int().min(0),
    note: z.string().trim().max(500).default(''),
  })
  // Flagging and sending back teach the Question Maker: say what was wrong.
  .refine((b) => !['flag', 'send_back'].includes(b.action) || b.note.length >= 3, { message: 'say what is wrong', path: ['note'] });
export type ItemActionBody = z.infer<typeof itemActionBodySchema>;
