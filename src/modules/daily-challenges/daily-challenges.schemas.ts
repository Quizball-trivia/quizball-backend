import { z } from 'zod';

export const dailyChallengeTypeEnum = z.enum([
  'moneyDrop',
  'trueFalse',
  'clues',
  'countdown',
  'putInOrder',
  'imposter',
  'careerPath',
  'highLow',
  'footballLogic',
]);

export const dailyChallengeMetadataSchema = z.object({
  challengeType: dailyChallengeTypeEnum,
  title: z.string().min(1),
  description: z.string().min(1),
  iconToken: z.enum([
    'dollarSign',
    'checkCircle',
    'lightbulb',
    'timer',
    'list',
    'users',
    'route',
    'trendingUp',
    'image',
  ]),
  coinReward: z.number().int().nonnegative(),
  xpReward: z.number().int().nonnegative(),
  showOnHome: z.boolean(),
  completedToday: z.boolean(),
  availableToday: z.boolean(),
});

export const adminDailyChallengeCategoryOptionSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  name: z.record(z.string(), z.string().min(1)),
  questionCount: z.number().int().nonnegative(),
  easyCount: z.number().int().nonnegative(),
  mediumCount: z.number().int().nonnegative(),
  hardCount: z.number().int().nonnegative(),
});

const moneyDropSettingsBaseSchema = z.object({
  categoryIds: z.array(z.string().uuid()).default([]),
  questionCount: z.number().int().min(1).max(20),
  secondsPerQuestion: z.number().int().min(5).max(120),
  startingMoney: z.number().int().min(100).max(100000),
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

const imposterSettingsBaseSchema = z.object({
  categoryIds: z.array(z.string().uuid()).default([]),
  questionCount: z.number().int().min(1).max(20),
  secondsPerQuestion: z.number().int().min(5).max(120),
});

const careerPathSettingsBaseSchema = z.object({
  categoryIds: z.array(z.string().uuid()).default([]),
  questionCount: z.number().int().min(1).max(20),
  secondsPerQuestion: z.number().int().min(5).max(120),
});

const highLowSettingsBaseSchema = z.object({
  categoryIds: z.array(z.string().uuid()).default([]),
  roundCount: z.number().int().min(1).max(10),
  secondsPerRound: z.number().int().min(5).max(180),
});

const footballLogicSettingsBaseSchema = z.object({
  categoryIds: z.array(z.string().uuid()).default([]),
  questionCount: z.number().int().min(1).max(20),
  secondsPerQuestion: z.number().int().min(5).max(120),
});

export const moneyDropSettingsSchema = moneyDropSettingsBaseSchema;
export const trueFalseSettingsSchema = trueFalseSettingsBaseSchema;
export const countdownSettingsSchema = countdownSettingsBaseSchema;
export const cluesSettingsSchema = cluesSettingsBaseSchema;
export const putInOrderSettingsSchema = putInOrderSettingsBaseSchema;
export const imposterSettingsSchema = imposterSettingsBaseSchema;
export const careerPathSettingsSchema = careerPathSettingsBaseSchema;
export const highLowSettingsSchema = highLowSettingsBaseSchema;
export const footballLogicSettingsSchema = footballLogicSettingsBaseSchema;

const moneyDropSettingsOpenApiSchema = moneyDropSettingsBaseSchema.extend({
  challengeType: z.literal('moneyDrop'),
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
const imposterSettingsOpenApiSchema = imposterSettingsBaseSchema.extend({
  challengeType: z.literal('imposter'),
});
const careerPathSettingsOpenApiSchema = careerPathSettingsBaseSchema.extend({
  challengeType: z.literal('careerPath'),
});
const highLowSettingsOpenApiSchema = highLowSettingsBaseSchema.extend({
  challengeType: z.literal('highLow'),
});
const footballLogicSettingsOpenApiSchema = footballLogicSettingsBaseSchema.extend({
  challengeType: z.literal('footballLogic'),
});

export const dailyChallengeSettingsSchema = z.discriminatedUnion('challengeType', [
  moneyDropSettingsOpenApiSchema,
  trueFalseSettingsOpenApiSchema,
  countdownSettingsOpenApiSchema,
  cluesSettingsOpenApiSchema,
  putInOrderSettingsOpenApiSchema,
  imposterSettingsOpenApiSchema,
  careerPathSettingsOpenApiSchema,
  highLowSettingsOpenApiSchema,
  footballLogicSettingsOpenApiSchema,
]);

export const dailyChallengeConfigResponseSchema = dailyChallengeMetadataSchema.extend({
  settings: dailyChallengeSettingsSchema,
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  availableCategories: z.array(adminDailyChallengeCategoryOptionSchema),
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

const trueFalseQuestionSchema = z.object({
  id: z.string().uuid(),
  category: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  prompt: z.string().min(1),
  trueLabel: z.string().min(1),
  falseLabel: z.string().min(1),
  correctAnswer: z.boolean(),
});

const imposterQuestionSchema = z.object({
  id: z.string().uuid(),
  category: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  prompt: z.string().min(1),
  options: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string().min(1),
    })
  ).min(4),
  correctOptionIds: z.array(z.string().min(1)).min(1),
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

const careerPathQuestionSchema = z.object({
  id: z.string().uuid(),
  category: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  prompt: z.string().min(1),
  clubs: z.array(z.string().min(1)).min(2),
  displayAnswer: z.string().min(1),
  acceptedAnswers: z.array(z.string().min(1)).min(1),
});

const highLowRoundSchema = z.object({
  id: z.string().uuid(),
  category: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  prompt: z.string().min(1),
  statLabel: z.string().min(1),
  matchups: z.array(
    z.object({
      id: z.string().min(1),
      leftName: z.string().min(1),
      leftValue: z.number(),
      rightName: z.string().min(1),
      rightValue: z.number(),
    })
  ).min(1),
});

const footballLogicQuestionSchema = z.object({
  id: z.string().uuid(),
  category: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  prompt: z.string().min(1).nullable(),
  imageAUrl: z.string().url(),
  imageBUrl: z.string().url(),
  displayAnswer: z.string().min(1),
  acceptedAnswers: z.array(z.string().min(1)).min(1),
  explanation: z.string().nullable(),
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
    challengeType: z.literal('trueFalse'),
    title: z.string().min(1),
    description: z.string().min(1),
    questionCount: z.number().int().positive(),
    secondsPerQuestion: z.number().int().positive(),
    questions: z.array(trueFalseQuestionSchema).min(1),
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
  z.object({
    challengeType: z.literal('imposter'),
    title: z.string().min(1),
    description: z.string().min(1),
    questionCount: z.number().int().positive(),
    secondsPerQuestion: z.number().int().positive(),
    questions: z.array(imposterQuestionSchema).min(1),
  }),
  z.object({
    challengeType: z.literal('careerPath'),
    title: z.string().min(1),
    description: z.string().min(1),
    questionCount: z.number().int().positive(),
    secondsPerQuestion: z.number().int().positive(),
    questions: z.array(careerPathQuestionSchema).min(1),
  }),
  z.object({
    challengeType: z.literal('highLow'),
    title: z.string().min(1),
    description: z.string().min(1),
    roundCount: z.number().int().positive(),
    secondsPerRound: z.number().int().positive(),
    rounds: z.array(highLowRoundSchema).min(1),
  }),
  z.object({
    challengeType: z.literal('footballLogic'),
    title: z.string().min(1),
    description: z.string().min(1),
    questionCount: z.number().int().positive(),
    secondsPerQuestion: z.number().int().positive(),
    questions: z.array(footballLogicQuestionSchema).min(1),
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

export const dailyChallengeLocaleQuerySchema = z.object({
  locale: z.string().min(2).max(16).optional(),
});

export type DailyChallengeType = z.infer<typeof dailyChallengeTypeEnum>;
export type MoneyDropSettings = z.infer<typeof moneyDropSettingsSchema>;
export type TrueFalseSettings = z.infer<typeof trueFalseSettingsSchema>;
export type CountdownSettings = z.infer<typeof countdownSettingsSchema>;
export type CluesSettings = z.infer<typeof cluesSettingsSchema>;
export type PutInOrderSettings = z.infer<typeof putInOrderSettingsSchema>;
export type ImposterSettings = z.infer<typeof imposterSettingsSchema>;
export type CareerPathSettings = z.infer<typeof careerPathSettingsSchema>;
export type HighLowSettings = z.infer<typeof highLowSettingsSchema>;
export type FootballLogicSettings = z.infer<typeof footballLogicSettingsSchema>;
export type DailyChallengeSettings = z.infer<typeof dailyChallengeSettingsSchema>;
export type AdminDailyChallengeCategoryOption = z.infer<typeof adminDailyChallengeCategoryOptionSchema>;
export type DailyChallengeSessionResponse = z.infer<typeof dailyChallengeSessionResponseSchema>;
export type DailyChallengeConfigResponse = z.infer<typeof dailyChallengeConfigResponseSchema>;
export type CompleteDailyChallengeBody = z.infer<typeof completeDailyChallengeBodySchema>;
export type UpdateDailyChallengeConfigBody = z.infer<typeof updateDailyChallengeConfigSchema>;
export type DailyChallengeParam = z.infer<typeof dailyChallengeParamSchema>;
export type DailyChallengeLocaleQuery = z.infer<typeof dailyChallengeLocaleQuerySchema>;
