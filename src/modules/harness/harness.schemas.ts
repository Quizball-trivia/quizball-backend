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
  // What the desk agents are told about the company.
  'company.profile': z.string().trim().min(20).max(4000),
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
  // One batch from the Question Maker: larger orders are placed as several.
  count: z.number().int().min(1).max(20),
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

// ── phase 2: events, new categories, Ask HQ ──────────────────────────────────

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const difficultyOrMixed = z.enum(['easy', 'medium', 'hard', 'mixed']);

export const createEventBodySchema = z.object({
  title: z.string().trim().min(3).max(200),
  happensOn: day,
  notes: z.string().trim().max(1000).default(''),
  categoryIds: z.array(z.string().uuid()).min(1).max(6),
  perCategory: z.number().int().min(1).max(20),
  difficulty: difficultyOrMixed.default('mixed'),
});
export type CreateEventBody = z.infer<typeof createEventBodySchema>;

export const createProposalBodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  why: z.string().trim().max(1000).default(''),
  target: z.number().int().min(10).max(100).default(30),
});
export type CreateProposalBody = z.infer<typeof createProposalBodySchema>;

export const idParamSchema = z.object({ id: z.string().uuid() });
export type IdParam = z.infer<typeof idParamSchema>;

export const swapShowQuestionBodySchema = z.object({ index: z.number().int().min(0).max(359), seen: z.string().datetime() });
export type SwapShowQuestionBody = z.infer<typeof swapShowQuestionBodySchema>;

export const approveShowPackBodySchema = z.object({ seen: z.string().datetime() });
export type ApproveShowPackBody = z.infer<typeof approveShowPackBodySchema>;

/** Trimmed text between `min` and `max` characters, counted as the database counts them (an emoji is one, not two). */
const chars = (min: number, max: number) =>
  z.string().trim().refine((v) => { const n = [...v].length; return n >= min && n <= max; }, `must be ${min} to ${max} characters`);
export const createGameChangeBodySchema = z.object({
  gameKey: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  title: chars(3, 140),
  request: chars(10, 6000),
});
export type CreateGameChangeBody = z.infer<typeof createGameChangeBodySchema>;
// ── reports (desk agents) ──

export const createReportBodySchema = z.object({ agent: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/) });
export type CreateReportBody = z.infer<typeof createReportBodySchema>;

export const replanGameChangeBodySchema = z.object({ request: chars(10, 6000) });
export type ReplanGameChangeBody = z.infer<typeof replanGameChangeBodySchema>;

export const createAskBodySchema = z.object({ message: z.string().trim().min(2).max(2000) });
export type CreateAskBody = z.infer<typeof createAskBodySchema>;

export const applyAskBodySchema = z.object({ indexes: z.array(z.number().int().min(0).max(19)).min(1).max(20) });
export type ApplyAskBody = z.infer<typeof applyAskBodySchema>;

/** What the HQ Assistant may propose: exactly the Content tab's own controls. */
export const askActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('priority'), categoryId: z.string().uuid(), priority: z.enum(STEERING_PRIORITIES) }),
  z.object({ type: z.literal('direction'), categoryId: z.string().uuid().nullable(), text: z.string().trim().max(1000) }),
  z.object({
    type: z.literal('order'),
    categoryId: z.string().uuid(),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    count: z.number().int().min(1).max(20),
    topic: z.string().trim().min(3).max(300),
    deadline: day.nullable().optional(),
  }),
  z.object({
    type: z.literal('event'),
    title: z.string().trim().min(3).max(200),
    happensOn: day,
    notes: z.string().trim().max(1000).default(''),
    categoryIds: z.array(z.string().uuid()).min(1).max(6),
    perCategory: z.number().int().min(1).max(20),
    difficulty: difficultyOrMixed.default('mixed'),
  }),
]);
export type AskAction = z.infer<typeof askActionSchema>;
