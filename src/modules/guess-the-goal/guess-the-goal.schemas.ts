import { z } from 'zod';

const clientNonceSchema = z.string().min(1).max(64).optional();

export const startSessionSchema = z.object({
  client_nonce: clientNonceSchema,
});
export type StartSessionRequest = z.infer<typeof startSessionSchema>;

export const guessSchema = z.object({
  option_id: z.string().min(1).max(64),
});
export type GuessRequest = z.infer<typeof guessSchema>;

export const bonusSchema = z.object({
  option_id: z.string().min(1).max(64),
});
export type BonusRequest = z.infer<typeof bonusSchema>;

export const sessionIdParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

// ── Choreography content schema ──────────────────────────────────────────────
// The single source of truth for what a valid goal choreography looks like.
// Used by the seed loader and any future authoring surface (CMS, agents) so
// broken geometry can never reach players.

const i18nTextSchema = z.object({
  en: z.string().min(1).max(300),
  ka: z.string().min(1).max(300).nullable().optional(),
});

const coordSchema = z.tuple([z.number().min(0).max(68), z.number().min(0).max(105)]);

const optionSchema = z.object({
  id: z.string().min(1).max(32),
  text: i18nTextSchema,
  is_correct: z.boolean(),
});

const optionsSchema = z
  .array(optionSchema)
  .length(4)
  .refine((opts) => opts.filter((o) => o.is_correct).length === 1, {
    message: 'exactly one option must be correct',
  })
  .refine((opts) => new Set(opts.map((o) => o.id)).size === 4, {
    message: 'option ids must be unique',
  });

const playerSchema = z.object({
  id: z.string().min(1).max(32),
  team: z.enum(['attack', 'defense', 'keeper']),
  at: coordSchema,
});

const stepSchema = z.object({
  kind: z.enum(['pass', 'carry', 'run', 'shot']),
  player: z.string().min(1).max(32),
  to: coordSchema,
  via: coordSchema.optional(),
  loft: z.number().min(0).max(1).optional(),
  withPrev: z.boolean().optional(),
  duration: z.number().min(0.3).max(5),
});

export const choreographyContentSchema = z
  .object({
    slug: z.string().min(3).max(80).regex(/^[a-z0-9-]+$/),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    title: i18nTextSchema,
    options: optionsSchema,
    fun_fact: i18nTextSchema.nullable().optional(),
    bonus: z
      .object({
        question: i18nTextSchema,
        options: optionsSchema,
      })
      .nullable()
      .optional(),
    players: z.array(playerSchema).min(2).max(22),
    steps: z.array(stepSchema).min(2).max(16),
    scorer: z.string().min(2).max(120),
    match_label: z.string().min(2).max(160),
    year: z.number().int().min(1900).max(2100),
    goal_ordinal: z.number().int().min(1).max(9).default(1),
    schema_version: z.literal(1).default(1),
  })
  .superRefine((goal, ctx) => {
    const playerIds = new Set(goal.players.map((p) => p.id));
    if (playerIds.size !== goal.players.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'player ids must be unique' });
    }
    const texts = goal.options.map((o) => o.text.en.trim().toLowerCase());
    if (new Set(texts).size !== texts.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'option texts must be distinct' });
    }
    const total = goal.steps.reduce(
      (acc, s) => (s.withPrev ? acc : acc + s.duration),
      0
    );
    if (total < 3 || total > 30) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `total main-step duration ${total.toFixed(1)}s outside 3–30s`,
      });
    }
    // Pass continuity: every pass must land near a teammate's position at some
    // point in the move (initial spot or any of their step endpoints).
    const attackSpots: Array<[number, number]> = [];
    for (const p of goal.players) if (p.team === 'attack') attackSpots.push(p.at);
    for (const s of goal.steps) if (s.kind === 'carry' || s.kind === 'run') attackSpots.push(s.to);
    for (const [i, step] of goal.steps.entries()) {
      if (step.kind !== 'pass') continue;
      const reachable = attackSpots.some(
        ([x, y]) => Math.hypot(x - step.to[0], y - step.to[1]) <= 6
      );
      if (!reachable) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step ${i}: pass lands ${step.to} with no attacker within 6m`,
        });
      }
    }
    for (const [i, step] of goal.steps.entries()) {
      if (!playerIds.has(step.player)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step ${i} references unknown player '${step.player}'`,
        });
      }
    }
    if (goal.steps[0]?.withPrev) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'first step cannot be withPrev' });
    }
    const last = goal.steps[goal.steps.length - 1];
    if (last && last.kind !== 'shot') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'last step must be a shot' });
    }
    if (last && last.kind === 'shot') {
      const [x, y] = last.to;
      if (y < 100 || Math.abs(x - 34) > 12) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'shot must end at the attacked goal mouth (y ≥ 100, near x=34)',
        });
      }
    }
    const mainCount = goal.steps.filter((s) => !s.withPrev).length;
    if (mainCount < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'need at least 2 main steps' });
    }
  });

export type ChoreographyContent = z.infer<typeof choreographyContentSchema>;
