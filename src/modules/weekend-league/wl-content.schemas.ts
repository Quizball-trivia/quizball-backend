import { z } from 'zod';
import { bulkCreateQuestionsSchema } from '../questions/questions.schemas.js';

/** One uploaded question — the exact shape the CMS bulk parser already emits. */
export const wlContentQuestionSchema = bulkCreateQuestionsSchema.shape.questions.element;
export type WlContentQuestion = z.infer<typeof wlContentQuestionSchema>;

export const wlContentCheckSchema = z.object({
  questions: z.array(wlContentQuestionSchema).min(1).max(100),
});
export type WlContentCheckRequest = z.infer<typeof wlContentCheckSchema>;

export const wlContentImportSchema = z.object({
  kind: z.enum(['true_false', 'put_in_order', 'mcq_single', 'career_path', 'clue_chain']),
  note: z.string().max(400).optional(),
  sync_to_staging: z.boolean().default(false),
  /** Row indexes the editor chose to publish although flagged duplicate/similar. Errors can never be forced. */
  force_indexes: z.array(z.number().int().min(0)).default([]),
  questions: z.array(wlContentQuestionSchema).min(1).max(100),
}).refine((b) => b.questions.every((q) => q.type === b.kind), {
  // A stale upload from a previous round type must never be published under the new one.
  message: 'Every question must be of the batch kind (round type)', path: ['questions'],
});
export type WlContentImportRequest = z.infer<typeof wlContentImportSchema>;

export const wlContentIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
});

export const wlContentRowStatusSchema = z.enum(['ready', 'warning', 'duplicate', 'played', 'error']);

export const wlContentRowReportSchema = z.object({
  index: z.number().int(),
  type: z.string(),
  status: wlContentRowStatusSchema,
  issues: z.array(wlContentIssueSchema),
  duplicate_of: z
    .object({
      question_id: z.string().uuid().nullable(),
      where: z.enum(['pool', 'public', 'history', 'batch']),
      played: z.boolean(),
      week_key: z.string().nullable(),
      status: z.string().nullable(),
    })
    .nullable(),
  similar_to: z
    .object({ question_id: z.string().uuid().nullable(), where: z.enum(['pool', 'public', 'history', 'batch']), week_key: z.string().nullable() })
    .nullable(),
  crests: z.array(z.object({ club: z.string(), club_id: z.string().nullable(), logo_url: z.string().nullable() })),
  image: z
    .object({
      ok: z.boolean(),
      url: z.string(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      bytes: z.number().nullable(),
      content_type: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
});
export type WlContentRowReport = z.infer<typeof wlContentRowReportSchema>;

export const wlContentCheckResponseSchema = z.object({
  rows: z.array(wlContentRowReportSchema),
  /** False on a backend without STAGING_DATABASE_URL — the CMS then greys out "copy to staging". */
  staging_configured: z.boolean(),
  summary: z.object({
    ready: z.number(),
    warning: z.number(),
    duplicate: z.number(),
    played: z.number(),
    error: z.number(),
  }),
});
export type WlContentCheckResponse = z.infer<typeof wlContentCheckResponseSchema>;

export const wlContentBatchRowSchema = z.object({
  row_index: z.number().int(),
  question_id: z.string().uuid().nullable(),
  state: z.enum(['pending', 'created', 'translated', 'published', 'failed', 'deleted']),
  error: z.string().nullable(),
  summary: z.string(),
  /** Where this question is dealt (newest event first); empty = still in the pool. */
  placements: z.array(z.object({
    week_key: z.string(),
    status: z.string(),
    game_index: z.number().int(),
    round_index: z.number().int().nullable(),
    question_index: z.number().int().nullable(),
    reserve_ordinal: z.number().int(),
    kind: z.string(),
  })),
  /** A lineup backup (the lineup this question replaced, or was replaced in) still points at it — Undo keeps it. */
  in_backup: z.boolean(),
});

export const wlContentBatchSchema = z.object({
  id: z.string().uuid(),
  created_at: z.string(),
  created_by: z.string().uuid().nullable(),
  created_by_email: z.string().nullable(),
  kind: z.string(),
  note: z.string().nullable(),
  status: z.enum(['processing', 'done', 'failed', 'undoing', 'undone']),
  row_count: z.number().int(),
  sync_to_staging: z.boolean(),
  result: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  undone_at: z.string().nullable(),
  counts: z.object({
    pending: z.number(),
    created: z.number(),
    translated: z.number(),
    published: z.number(),
    failed: z.number(),
    deleted: z.number(),
  }),
});
export type WlContentBatch = z.infer<typeof wlContentBatchSchema>;

export const wlLineupPlacementSchema = z.object({
  tournament_id: z.string().uuid(),
  week_key: z.string(),
  games: z.array(z.number().int()),
  at: z.string(),
  slots: z.array(z.object({
    game_index: z.number().int(), round_index: z.number().int().nullable(), question_index: z.number().int().nullable(),
    reserve_ordinal: z.number().int(), kind: z.string(), origin: z.enum(['upload', 'pool']), source_question_id: z.string().uuid(),
    summary: z.string(), current: z.boolean(),
  })),
});

export const wlContentBatchDetailSchema = wlContentBatchSchema.extend({
  rows: z.array(wlContentBatchRowSchema),
  /** For a lineup upload: every slot it saved (uploaded + pool reserves) and whether the weekend still holds it. */
  lineup: wlLineupPlacementSchema.nullable(),
});

// ─── lineup upload ────────────────────────────────────────────────────────────

export const wlLineupScopeSchema = z.enum(['game_0', 'game_1', 'game_2', 'game_3', 'saturday', 'weekend']);

export const wlLineupSlotSchema = z.object({
  game_index: z.number().int().min(0).max(3),
  round_index: z.number().int().min(0).max(4).nullable(),
  question_index: z.number().int().min(0).max(4).nullable(),
  reserve_ordinal: z.number().int().min(0).max(2),
});

export const wlLineupPreviewSchema = z.object({
  tournament_id: z.string().uuid(),
  scope: wlLineupScopeSchema,
  note: z.string().max(400).nullish(),
  /** Up to four games of 21 questions plus 10 reserves each. */
  questions: z.array(wlContentQuestionSchema).min(1).max(124),
  slots: z.array(wlLineupSlotSchema),
  /** Line in the editor's file per question, echoed back in messages. */
  lines: z.array(z.number().int().nullable()).optional(),
  force_indexes: z.array(z.number().int().min(0)).default([]),
}).refine((b) => b.slots.length === b.questions.length, { message: 'One slot per question', path: ['slots'] });

export const wlLineupSaveSchema = z.object({ preview_id: z.string().uuid() });

export const wlLineupEventSchema = z.object({
  id: z.string().uuid(),
  week_key: z.string(),
  status: z.string(),
  answers: z.number().int(),
  editable: z.boolean(),
  reason: z.string().nullable(),
  games: z.array(z.object({ game_index: z.number().int(), rows: z.number().int(), complete: z.boolean() })),
});

const wlQuestionViewSchema = z.object({}).passthrough();

export const wlLineupPreviewResponseSchema = z.object({
  preview_id: z.string().uuid().nullable(),
  expires_at: z.string().nullable(),
  event: z.object({ id: z.string().uuid(), week_key: z.string(), status: z.string() }),
  scope: z.string(),
  games: z.array(z.number().int()),
  kept_games: z.array(z.number().int()),
  slots: z.array(z.object({
    game_index: z.number().int(), round_index: z.number().int().nullable(), question_index: z.number().int().nullable(),
    reserve_ordinal: z.number().int(), kind: z.string(), origin: z.enum(['upload', 'pool']), row_index: z.number().int().nullable(),
    view: wlQuestionViewSchema.nullable(),
  })),
  replaced: z.array(z.object({ game_index: z.number().int(), rows: z.array(wlQuestionViewSchema) })),
  checks: wlContentCheckResponseSchema,
  problems: z.array(z.object({ where: z.string(), message: z.string(), row_index: z.number().int().nullable() })),
  undecided: z.array(z.number().int()),
});

export const wlLineupSaveResponseSchema = z.object({ batch_id: z.string().uuid(), accepted: z.number().int(), already_started: z.boolean() });

export const wlContentImportResponseSchema = z.object({
  batch_id: z.string().uuid(),
  accepted: z.number().int(),
});

export const wlContentRunwaySchema = z.object({
  need_per_event: z.record(z.number()),
  inventory: z.array(
    z.object({
      type: z.string(),
      difficulty: z.string(),
      photo: z.boolean(),
      fresh: z.number(),
    })
  ),
  drawable: z.array(z.object({ kind: z.string(), drawable: z.number(), need: z.number(), events_left: z.number() })),
  fresh_events_left: z.record(z.number()),
});

export const wlContentReseedResponseSchema = z.object({
  ok: z.boolean(),
  inserted: z.number(),
  previous_rows: z.number(),
  shortages: z.record(z.object({ need: z.number(), have: z.number() })).optional(),
  reseed_id: z.string().uuid().nullable(),
});

export const wlContentScheduleSchema = z.object({ tournament_id: z.string().uuid().optional() });

export const wlContentScheduleResponseSchema = wlContentReseedResponseSchema.extend({
  week_key: z.string(),
  /** Of the batch's published questions: how many landed in main slots, reserves, or nowhere (e.g. more than the event needs). */
  placed_main: z.number().int(),
  placed_reserve: z.number().int(),
  not_placed: z.number().int(),
});
