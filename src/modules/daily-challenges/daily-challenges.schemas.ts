import { z } from 'zod';

export const dailyChallengeTypeEnum = z.enum([
  'moneyDrop',
  'footballJeopardy',
  'trueFalse',
  'clues',
  'countdown',
  'putInOrder',
]);

export const dailyChallengeMetadataSchema = z.object({
  challengeType: dailyChallengeTypeEnum,
  title: z.string().min(1),
  description: z.string().min(1),
  iconToken: z.enum(['dollarSign', 'brain', 'checkCircle', 'lightbulb', 'timer', 'list']),
  coinReward: z.number().int().nonnegative(),
  xpReward: z.number().int().nonnegative(),
  showOnHome: z.boolean(),
  completedToday: z.boolean(),
  availableToday: z.boolean(),
});

const moneyDropSettingsBaseSchema = z.object({
  categoryIds: z.array(z.string().uuid()).default([]),
  questionCount: z.number().int().min(1).max(20),
  secondsPerQuestion: z.number().int().min(5).max(120),
  startingMoney: z.number().int().min(100).max(100000),
});

const footballJeopardySettingsBaseSchema = z.object({
  categoryIds: z.array(z.string().uuid()).default([]),
  pickCount: z.number().int().min(1).max(9),
});

const trueFalseSettingsBaseSchema = z.object({
  categoryIds: z.array(z.string().uuid()).default([]),
  questionCount: z.number().int().min(1).max(20),
  secondsPerQuestion: z.number().int().min(5).max(120),
});

const countdownSettingsBaseSchema = z.object({
  categoryIds: z.array(z.string().uuid()).default([]),
  roundCount: z.number().int().min(1).max(10),
  secondsPerRound: z.number().int().min(5).max(180),
});

const cluesSettingsBaseSchema = z.object({
  categoryIds: z.array(z.string().uuid()).default([]),
  questionCount: z.number().int().min(1).max(20),
  secondsPerClueStep: z.number().int().min(3).max(60),
});

const putInOrderSettingsBaseSchema = z.object({
  categoryIds: z.array(z.string().uuid()).default([]),
  roundCount: z.number().int().min(1).max(10),
  itemsPerRound: z.number().int().min(3).max(8),
});

export const moneyDropSettingsSchema = moneyDropSettingsBaseSchema;
export const footballJeopardySettingsSchema = footballJeopardySettingsBaseSchema;
export const trueFalseSettingsSchema = trueFalseSettingsBaseSchema;
export const countdownSettingsSchema = countdownSettingsBaseSchema;
export const cluesSettingsSchema = cluesSettingsBaseSchema;
export const putInOrderSettingsSchema = putInOrderSettingsBaseSchema;

const moneyDropSettingsOpenApiSchema = moneyDropSettingsBaseSchema.extend({
  challengeType: z.literal('moneyDrop'),
});
const footballJeopardySettingsOpenApiSchema = footballJeopardySettingsBaseSchema.extend({
  challengeType: z.literal('footballJeopardy'),
});
const trueFalseSettingsOpenApiSchema = trueFalseSettingsBaseSchema.extend({
  challengeType: z.literal('trueFalse'),
});
const countdownSettingsOpenApiSchema = countdownSettingsBaseSchema.extend({
  challengeType: z.literal('countdown'),
});
const cluesSettingsOpenApiSchema = cluesSettingsBaseSchema.extend({
  challengeType: z.literal('clues'),
});
const putInOrderSettingsOpenApiSchema = putInOrderSettingsBaseSchema.extend({
  challengeType: z.literal('putInOrder'),
});

export const dailyChallengeSettingsSchema = z.discriminatedUnion('challengeType', [
  moneyDropSettingsOpenApiSchema,
  footballJeopardySettingsOpenApiSchema,
  trueFalseSettingsOpenApiSchema,
  countdownSettingsOpenApiSchema,
  cluesSettingsOpenApiSchema,
  putInOrderSettingsOpenApiSchema,
]);

export const dailyChallengeConfigResponseSchema = dailyChallengeMetadataSchema.extend({
  settings: dailyChallengeSettingsSchema,
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});

export const listDailyChallengesResponseSchema = z.object({
  items: z.array(dailyChallengeMetadataSchema),
});

export const listAdminDailyChallengesResponseSchema = z.object({
  items: z.array(dailyChallengeConfigResponseSchema),
});

const moneyDropQuestionSchema = z.object({
  id: z.string().uuid(),
  category: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  prompt: z.string().min(1),
  options: z.array(z.string().min(1)).length(4),
  correctAnswerIndex: z.number().int().min(0).max(3),
  clue: z.string().nullable(),
});

const jeopardyQuestionSchema = z.object({
  id: z.string().uuid(),
  value: z.union([z.literal(100), z.literal(200), z.literal(300)]),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  prompt: z.string().min(1),
  options: z.array(z.string().min(1)).length(4),
  correctAnswerIndex: z.number().int().min(0).max(3),
  clue: z.string().nullable(),
});

const countdownRoundSchema = z.object({
  id: z.string().uuid(),
  category: z.string().min(1),
  prompt: z.string().min(1),
  answerGroups: z.array(
    z.object({
      id: z.string().min(1),
      display: z.string().min(1),
      acceptedAnswers: z.array(z.string().min(1)).min(1),
    })
  ),
});

const clueQuestionSchema = z.object({
  id: z.string().uuid(),
  category: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  displayAnswer: z.string().min(1),
  acceptedAnswers: z.array(z.string().min(1)).min(1),
  clues: z.array(
    z.object({
      type: z.enum(['text', 'emoji']),
      content: z.string().min(1),
    })
  ).min(1),
});

const putInOrderRoundSchema = z.object({
  id: z.string().uuid(),
  category: z.string().min(1),
  prompt: z.string().min(1),
  direction: z.enum(['asc', 'desc']),
  items: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      details: z.string().nullable(),
      emoji: z.string().nullable(),
      sortValue: z.number(),
    })
  ).min(3),
});

export const dailyChallengeSessionResponseSchema = z.discriminatedUnion('challengeType', [
  z.object({
    challengeType: z.literal('moneyDrop'),
    title: z.string().min(1),
    description: z.string().min(1),
    questionCount: z.number().int().positive(),
    secondsPerQuestion: z.number().int().positive(),
    startingMoney: z.number().int().positive(),
    questions: z.array(moneyDropQuestionSchema).min(1),
  }),
  z.object({
    challengeType: z.literal('footballJeopardy'),
    title: z.string().min(1),
    description: z.string().min(1),
    pickCount: z.number().int().positive(),
    categories: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1),
        questions: z.array(jeopardyQuestionSchema).length(3),
      })
    ).min(1),
  }),
  z.object({
    challengeType: z.literal('countdown'),
    title: z.string().min(1),
    description: z.string().min(1),
    roundCount: z.number().int().positive(),
    secondsPerRound: z.number().int().positive(),
    rounds: z.array(countdownRoundSchema).min(1),
  }),
  z.object({
    challengeType: z.literal('clues'),
    title: z.string().min(1),
    description: z.string().min(1),
    questionCount: z.number().int().positive(),
    secondsPerClueStep: z.number().int().positive(),
    questions: z.array(clueQuestionSchema).min(1),
  }),
  z.object({
    challengeType: z.literal('putInOrder'),
    title: z.string().min(1),
    description: z.string().min(1),
    roundCount: z.number().int().positive(),
    itemsPerRound: z.number().int().positive(),
    rounds: z.array(putInOrderRoundSchema).min(1),
  }),
]);

export const completeDailyChallengeBodySchema = z.object({
  score: z.number().int().nonnegative().default(0),
});

export const completeDailyChallengeResponseSchema = z.object({
  challengeType: dailyChallengeTypeEnum,
  completedToday: z.literal(true),
  coinsAwarded: z.number().int().nonnegative(),
  xpAwarded: z.number().int().nonnegative(),
  wallet: z.object({
    coins: z.number().int().nonnegative(),
    tickets: z.number().int().nonnegative(),
  }).optional(),
});

export const resetDailyChallengeResponseSchema = z.object({
  challengeType: dailyChallengeTypeEnum,
  reset: z.literal(true),
});

export const updateDailyChallengeConfigSchema = z.object({
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  showOnHome: z.boolean(),
  coinReward: z.number().int().nonnegative(),
  xpReward: z.number().int().nonnegative(),
  settings: dailyChallengeSettingsSchema,
});

export const dailyChallengeParamSchema = z.object({
  challengeType: dailyChallengeTypeEnum,
});

export type DailyChallengeType = z.infer<typeof dailyChallengeTypeEnum>;
export type MoneyDropSettings = z.infer<typeof moneyDropSettingsSchema>;
export type FootballJeopardySettings = z.infer<typeof footballJeopardySettingsSchema>;
export type TrueFalseSettings = z.infer<typeof trueFalseSettingsSchema>;
export type CountdownSettings = z.infer<typeof countdownSettingsSchema>;
export type CluesSettings = z.infer<typeof cluesSettingsSchema>;
export type PutInOrderSettings = z.infer<typeof putInOrderSettingsSchema>;
export type DailyChallengeSettings = z.infer<typeof dailyChallengeSettingsSchema>;
export type DailyChallengeSessionResponse = z.infer<typeof dailyChallengeSessionResponseSchema>;
export type DailyChallengeConfigResponse = z.infer<typeof dailyChallengeConfigResponseSchema>;
export type CompleteDailyChallengeBody = z.infer<typeof completeDailyChallengeBodySchema>;
export type UpdateDailyChallengeConfigBody = z.infer<typeof updateDailyChallengeConfigSchema>;
export type DailyChallengeParam = z.infer<typeof dailyChallengeParamSchema>;
