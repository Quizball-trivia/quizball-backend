import type { Json } from '../../db/types.js';
import {
  AuthorizationError,
  DailyChallengeAlreadyCompletedError,
  DailyChallengeContentUnavailableError,
  NotFoundError,
  ValidationError,
} from '../../core/errors.js';
import { getLocalizedString } from '../../lib/localization.js';
import { categoriesRepo } from '../categories/categories.repo.js';
import {
  questionPayloadSchema,
  type QuestionPayload,
  type QuestionType,
} from '../questions/questions.schemas.js';
import { DAILY_CHALLENGE_DEFINITIONS } from './daily-challenges.definitions.js';
import { dailyChallengesRepo } from './daily-challenges.repo.js';
import {
  careerPathSettingsSchema,
  cluesSettingsSchema,
  countdownSettingsSchema,
  footballLogicSettingsSchema,
  highLowSettingsSchema,
  imposterSettingsSchema,
  moneyDropSettingsSchema,
  putInOrderSettingsSchema,
  trueFalseSettingsSchema,
  dailyChallengeTypeEnum,
  type DailyChallengeSettings,
} from './daily-challenges.schemas.js';
import type {
  DailyChallengeAvailableCategoryRow,
  DailyChallengeCompletionRow,
  DailyChallengeConfigRow,
  DailyChallengeLocalizedText,
  DailyChallengeType,
  QuestionContentRow,
} from './daily-challenges.types.js';

function getUtcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const dailyChallengeSettingsSchemas = {
  moneyDrop: moneyDropSettingsSchema,
  trueFalse: trueFalseSettingsSchema,
  countdown: countdownSettingsSchema,
  clues: cluesSettingsSchema,
  putInOrder: putInOrderSettingsSchema,
  imposter: imposterSettingsSchema,
  careerPath: careerPathSettingsSchema,
  highLow: highLowSettingsSchema,
  footballLogic: footballLogicSettingsSchema,
} as const;

const SUPPORTED_DAILY_CHALLENGE_LOCALES = ['en', 'ka'] as const;

type QuestionPayloadType = QuestionPayload['type'];
type PayloadOfType<TType extends QuestionPayloadType> = Extract<QuestionPayload, { type: TType }>;
type DailyChallengeLocale = (typeof SUPPORTED_DAILY_CHALLENGE_LOCALES)[number];
type ContentAvailabilityDetails = {
  categoryIds: string[];
  questionType: QuestionPayloadType;
  rawPublishedInSelectedCategories?: number;
  validPublishedInSelectedCategories?: number;
  rawPublishedAcrossAllCategories?: number;
  validPublishedAcrossAllCategories?: number;
};

function isDailyChallengeType(value: unknown): value is DailyChallengeType {
  return dailyChallengeTypeEnum.safeParse(value).success;
}

function isKnownDailyChallengeConfig(config: DailyChallengeConfigRow): boolean {
  return isDailyChallengeType(config.challenge_type);
}

function normalizeDailyChallengeLocale(locale?: string): DailyChallengeLocale {
  const normalized = locale?.trim().toLowerCase();
  if (!normalized) {
    return 'en';
  }
  if (normalized === 'ka' || normalized.startsWith('ka-')) {
    return 'ka';
  }
  return 'en';
}

function getLocalePreferences(locale?: string): string[] {
  const normalized = normalizeDailyChallengeLocale(locale);
  return normalized === 'en' ? ['en'] : [normalized, 'en'];
}

function getLocalizationOptions(locale?: string, fallback?: string) {
  return {
    preferredLocales: getLocalePreferences(locale),
    ...(fallback !== undefined ? { fallback } : {}),
  };
}

function throwAlreadyCompleted(challengeType: DailyChallengeType): never {
  throw new DailyChallengeAlreadyCompletedError({ challengeType });
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function pickRandom<T>(items: T[], count: number): T[] {
  return shuffle(items).slice(0, count);
}

function ensureEnough<T>(
  items: T[],
  needed: number,
  challengeType: DailyChallengeType,
  details: object
): T[] {
  if (items.length < needed) {
    throw new DailyChallengeContentUnavailableError({
      challengeType,
      needed,
      available: items.length,
      ...details,
    });
  }
  return items;
}

async function ensureActiveCategories(
  challengeType: DailyChallengeType,
  categoryIds: string[]
): Promise<void> {
  if (categoryIds.length === 0) {
    return;
  }

  const categories = await categoriesRepo.listByIds(categoryIds);
  const activeIds = new Set(categories.filter((row) => row.is_active).map((row) => row.id));
  const invalidIds = categoryIds.filter((categoryId) => !activeIds.has(categoryId));

  if (invalidIds.length > 0) {
    throw new ValidationError('Daily challenge references inactive or missing categories', {
      challengeType,
      invalidCategoryIds: invalidIds,
    });
  }
}

function getDefinition(challengeType: DailyChallengeType) {
  return DAILY_CHALLENGE_DEFINITIONS[challengeType];
}

function getDefinitionText(value: DailyChallengeLocalizedText, locale?: string): string {
  return getLocalizedString(value as unknown as Json, getLocalizationOptions(locale, value.en));
}

function getDefinitionTitle(challengeType: DailyChallengeType, locale?: string): string {
  return getDefinitionText(getDefinition(challengeType).title, locale);
}

function getDefinitionDescription(challengeType: DailyChallengeType, locale?: string): string {
  return getDefinitionText(getDefinition(challengeType).description, locale);
}

function getQuestionTypeForChallenge(challengeType: DailyChallengeType): QuestionType {
  switch (challengeType) {
    case 'moneyDrop':
      return 'mcq_single';
    case 'trueFalse':
      return 'true_false';
    case 'countdown':
      return 'countdown_list';
    case 'clues':
      return 'clue_chain';
    case 'putInOrder':
      return 'put_in_order';
    case 'imposter':
      return 'imposter_multi_select';
    case 'careerPath':
      return 'career_path';
    case 'highLow':
      return 'high_low';
    case 'footballLogic':
      return 'football_logic';
  }
}

function toAvailableCategoryOption(row: DailyChallengeAvailableCategoryRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    questionCount: row.question_count,
    easyCount: row.easy_count,
    mediumCount: row.medium_count,
    hardCount: row.hard_count,
  };
}

function parsePayloadOfType<TType extends QuestionPayloadType>(
  row: QuestionContentRow,
  questionType: TType
): PayloadOfType<TType> | null {
  const parsed = questionPayloadSchema.safeParse(row.payload);
  if (!parsed.success || parsed.data.type !== questionType) {
    return null;
  }
  return parsed.data as PayloadOfType<TType>;
}

function getQuestionCategory(row: QuestionContentRow, locale?: string): string {
  return getLocalizedString(row.category_name, getLocalizationOptions(locale, 'Football'));
}

function getLegacyPayloadPrompt(payload: Json | null, locale?: string): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const promptValue =
    candidate.prompt ??
    candidate.question ??
    candidate.title ??
    candidate.stem;

  if (typeof promptValue === 'string') {
    const normalized = promptValue.trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (promptValue && typeof promptValue === 'object' && !Array.isArray(promptValue)) {
    const localizedPrompt = getLocalizedString(promptValue as Json, getLocalizationOptions(locale, '')).trim();
    return localizedPrompt.length > 0 ? localizedPrompt : null;
  }

  return null;
}

function parseStringifiedLocalizedPrompt(value: string, locale?: string): string | null {
  const normalized = value.trim();
  if (!normalized.startsWith('{') || !normalized.endsWith('}')) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(normalized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const prompt = getLocalizedString(parsed as Json, getLocalizationOptions(locale, '')).trim();
    return prompt.length > 0 ? prompt : null;
  } catch {
    return null;
  }
}

function getPromptText(value: Json | null, locale?: string): string | null {
  if (typeof value === 'string') {
    const localizedPrompt = parseStringifiedLocalizedPrompt(value, locale);
    if (localizedPrompt) {
      return localizedPrompt;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const prompt = getLocalizedString(value, getLocalizationOptions(locale, '')).trim();
  return prompt.length > 0 ? prompt : null;
}

function getQuestionPrompt(row: QuestionContentRow, locale?: string): string {
  const prompt = getPromptText(row.prompt, locale);
  if (prompt) {
    return prompt;
  }

  const legacyPrompt = getLegacyPayloadPrompt(row.payload, locale);
  if (legacyPrompt) {
    return legacyPrompt;
  }

  return 'Question';
}

function getOptionalQuestionPrompt(row: QuestionContentRow, locale?: string): string | null {
  const prompt = getQuestionPrompt(row, locale);
  return prompt === 'Question' ? null : prompt;
}

function getQuestionPromptOrFallback(row: QuestionContentRow, fallback: string, locale?: string): string {
  const prompt = getOptionalQuestionPrompt(row, locale);
  return prompt ?? fallback;
}

function getLocalizedText(value: Json, fallback: string, locale?: string): string {
  const localized = getLocalizedString(value, getLocalizationOptions(locale, fallback)).trim();
  return localized.length > 0 ? localized : fallback;
}

function getQuestionClue(explanation: Json | null, locale?: string): string | null {
  if (!explanation) {
    return null;
  }

  const clue = getLocalizedString(explanation, getLocalizationOptions(locale, '')).trim();
  return clue.length > 0 ? clue : null;
}

async function listAvailableCategoriesForChallenge(challengeType: DailyChallengeType) {
  const rows = await dailyChallengesRepo.listAvailableCategoriesByQuestionType(
    getQuestionTypeForChallenge(challengeType)
  );
  return rows.map(toAvailableCategoryOption);
}

async function ensureEligibleCategories(
  challengeType: DailyChallengeType,
  categoryIds: string[]
): Promise<void> {
  if (categoryIds.length === 0) {
    return;
  }

  const availableCategories = await listAvailableCategoriesForChallenge(challengeType);
  const availableCategoryIds = new Set(availableCategories.map((category) => category.id));
  const invalidIds = categoryIds.filter((categoryId) => !availableCategoryIds.has(categoryId));

  if (invalidIds.length > 0) {
    throw new ValidationError('Daily challenge references categories without eligible question content', {
      challengeType,
      invalidCategoryIds: invalidIds,
      requiredQuestionType: getQuestionTypeForChallenge(challengeType),
    });
  }
}

function toListItem(
  config: DailyChallengeConfigRow,
  completion: DailyChallengeCompletionRow | undefined,
  locale?: string
) {
  const definition = getDefinition(config.challenge_type);
  return {
    challengeType: config.challenge_type,
    title: getDefinitionText(definition.title, locale),
    description: getDefinitionText(definition.description, locale),
    iconToken: definition.iconToken,
    coinReward: config.coin_reward,
    xpReward: config.xp_reward,
    showOnHome: config.show_on_home,
    completedToday: completion != null,
    availableToday: completion == null,
  };
}

async function listTypedQuestionRows<TType extends QuestionPayloadType>(
  categoryIds: string[],
  questionType: TType,
  options?: { limit?: number }
): Promise<Array<{ row: QuestionContentRow; payload: PayloadOfType<TType> }>> {
  const rows = await dailyChallengesRepo.listPublishedQuestionsByTypeAndCategories(
    questionType,
    categoryIds,
    options
  );

  return rows
    .map((row) => {
      const payload = parsePayloadOfType(row, questionType);
      return payload ? { row, payload } : null;
    })
    .filter((item): item is { row: QuestionContentRow; payload: PayloadOfType<TType> } => item !== null);
}

async function getContentAvailabilityDetails<TType extends QuestionPayloadType>(
  categoryIds: string[],
  questionType: TType,
  validRows: Array<{ row: QuestionContentRow; payload: PayloadOfType<TType> }>
): Promise<ContentAvailabilityDetails> {
  const rawPublishedInSelectedCategories =
    await dailyChallengesRepo.countPublishedQuestionsByTypeAndCategories(questionType, categoryIds);

  if (categoryIds.length === 0) {
    return {
      categoryIds,
      questionType,
      rawPublishedInSelectedCategories,
      validPublishedInSelectedCategories: validRows.length,
    };
  }

  const allValidRows = await listTypedQuestionRows([], questionType);
  const rawPublishedAcrossAllCategories =
    await dailyChallengesRepo.countPublishedQuestionsByTypeAndCategories(questionType, []);

  return {
    categoryIds,
    questionType,
    rawPublishedInSelectedCategories,
    validPublishedInSelectedCategories: validRows.length,
    rawPublishedAcrossAllCategories,
    validPublishedAcrossAllCategories: allValidRows.length,
  };
}

export const dailyChallengesService = {
  async listActiveChallenges(userId: string, locale?: string) {
    const day = getUtcDay();
    const [configs, completions] = await Promise.all([
      dailyChallengesRepo.listConfigs(true),
      dailyChallengesRepo.listCompletionsForUserOnDay(userId, day),
    ]);
    const knownConfigs = configs.filter(isKnownDailyChallengeConfig);
    const completionByType = new Map(completions.map((item) => [item.challenge_type, item]));

    return knownConfigs.map((config) => toListItem(config, completionByType.get(config.challenge_type), locale));
  },

  async listAdminConfigs() {
    const configs = (await dailyChallengesRepo.listConfigs(false)).filter(isKnownDailyChallengeConfig);
    const categoryOptionsByType = new Map(
      await Promise.all(
        configs.map(async (config) => [
          config.challenge_type,
          await listAvailableCategoriesForChallenge(config.challenge_type),
        ] as const)
      )
    );

    return configs.map((config) => ({
      ...toListItem(config, undefined),
      isActive: config.is_active,
      sortOrder: config.sort_order,
      settings: this.parseSettings(config.challenge_type, config.settings),
      availableCategories: categoryOptionsByType.get(config.challenge_type) ?? [],
    }));
  },

  async updateConfig(
    challengeType: DailyChallengeType,
    input: {
      isActive: boolean;
      sortOrder: number;
      showOnHome: boolean;
      coinReward: number;
      xpReward: number;
      settings: unknown;
    }
  ) {
    const settings = this.parseSettings(challengeType, input.settings);
    const categoryIds = this.extractCategoryIds(challengeType, settings);

    await ensureActiveCategories(challengeType, categoryIds);
    await ensureEligibleCategories(challengeType, categoryIds);

    const config = await dailyChallengesRepo.upsertConfig({
      challengeType,
      ...input,
      settings,
    });

    const availableCategories = await listAvailableCategoriesForChallenge(challengeType);

    return {
      ...toListItem(config, undefined),
      isActive: config.is_active,
      sortOrder: config.sort_order,
      settings: this.parseSettings(config.challenge_type, config.settings),
      availableCategories,
    };
  },

  parseSettings(challengeType: DailyChallengeType, settings: unknown) {
    const schema = dailyChallengeSettingsSchemas[challengeType];
    const parsed = schema.safeParse(settings);

    if (!parsed.success) {
      throw new ValidationError('Invalid daily challenge settings', parsed.error.flatten());
    }

    return { challengeType, ...parsed.data } as DailyChallengeSettings;
  },

  extractCategoryIds(challengeType: DailyChallengeType, settings: unknown): string[] {
    const parsed = this.parseSettings(challengeType, settings);
    return parsed.categoryIds;
  },

  async getChallengeSession(userId: string, challengeType: DailyChallengeType, locale?: string) {
    const day = getUtcDay();
    const config = await dailyChallengesRepo.getConfig(challengeType);
    if (!config || !config.is_active) {
      throw new NotFoundError('Daily challenge not available');
    }

    const completion = await dailyChallengesRepo.getCompletionForUserOnDay(userId, challengeType, day);
    if (completion) {
      throwAlreadyCompleted(challengeType);
    }

    if (challengeType === 'moneyDrop') {
      const settings = moneyDropSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);

      const validRows = await listTypedQuestionRows(
        settings.categoryIds,
        'mcq_single',
        { limit: settings.questionCount * 5 }
      );
      const validQuestions = validRows.filter(({ row }) => getOptionalQuestionPrompt(row, locale) !== null);
      const selected = pickRandom(
        ensureEnough(validQuestions, settings.questionCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.questionCount
      );

      return {
        challengeType,
        title: getDefinitionTitle(challengeType, locale),
        description: getDefinitionDescription(challengeType, locale),
        questionCount: settings.questionCount,
        secondsPerQuestion: settings.secondsPerQuestion,
        startingMoney: settings.startingMoney,
        questions: selected.map(({ row, payload }) => ({
          id: row.id,
          category: getQuestionCategory(row, locale),
          difficulty: row.difficulty,
          prompt: getQuestionPrompt(row, locale),
          options: payload.options.map((option) => getLocalizedText(option.text as Json, 'Option', locale)),
          correctAnswerIndex: payload.options.findIndex((option) => option.is_correct),
          clue: getQuestionClue(row.explanation, locale),
        })),
      };
    }

    if (challengeType === 'trueFalse') {
      const settings = trueFalseSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);

      const validRows = await listTypedQuestionRows(
        settings.categoryIds,
        'true_false',
        { limit: settings.questionCount * 5 }
      );
      const availabilityDetails = await getContentAvailabilityDetails(
        settings.categoryIds,
        'true_false',
        validRows
      );
      const selected = pickRandom(
        ensureEnough(validRows, settings.questionCount, challengeType, availabilityDetails),
        settings.questionCount
      );

      return {
        challengeType,
        title: getDefinitionTitle(challengeType, locale),
        description: getDefinitionDescription(challengeType, locale),
        questionCount: settings.questionCount,
        secondsPerQuestion: settings.secondsPerQuestion,
        questions: selected.map(({ row, payload }) => ({
          id: row.id,
          category: getQuestionCategory(row, locale),
          difficulty: row.difficulty,
          prompt: getQuestionPrompt(row, locale),
          trueLabel: getLocalizedText(payload.options[0].text as Json, 'True', locale),
          falseLabel: getLocalizedText(payload.options[1].text as Json, 'False', locale),
          correctAnswer: payload.options[0].is_correct,
        })),
      };
    }

    if (challengeType === 'countdown') {
      const settings = countdownSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);

      const validRows = await listTypedQuestionRows(
        settings.categoryIds,
        'countdown_list',
        { limit: settings.roundCount * 5 }
      );
      const selected = pickRandom(
        ensureEnough(validRows, settings.roundCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.roundCount
      );

      return {
        challengeType,
        title: getDefinitionTitle(challengeType, locale),
        description: getDefinitionDescription(challengeType, locale),
        roundCount: settings.roundCount,
        secondsPerRound: settings.secondsPerRound,
        rounds: selected.map(({ row, payload }) => ({
          id: row.id,
          category: getQuestionCategory(row, locale),
          prompt: getLocalizedText(payload.prompt as Json, 'Countdown', locale),
          answerGroups: payload.answer_groups.map((group) => ({
            id: group.id,
            display: getLocalizedText(group.display as Json, 'Answer', locale),
            acceptedAnswers: group.accepted_answers,
          })),
        })),
      };
    }

    if (challengeType === 'clues') {
      const settings = cluesSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);

      const validRows = await listTypedQuestionRows(
        settings.categoryIds,
        'clue_chain',
        { limit: settings.questionCount * 5 }
      );
      const selected = pickRandom(
        ensureEnough(validRows, settings.questionCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.questionCount
      );

      return {
        challengeType,
        title: getDefinitionTitle(challengeType, locale),
        description: getDefinitionDescription(challengeType, locale),
        questionCount: settings.questionCount,
        secondsPerClueStep: settings.secondsPerClueStep,
        questions: selected.map(({ row, payload }) => ({
          id: row.id,
          category: getQuestionCategory(row, locale),
          difficulty: row.difficulty,
          displayAnswer: getLocalizedText(payload.display_answer as Json, 'Answer', locale),
          acceptedAnswers: payload.accepted_answers,
          clues: payload.clues.map((clue) => ({
            type: clue.type,
            content: getLocalizedText(clue.content as Json, 'Clue', locale),
          })),
        })),
      };
    }

    if (challengeType === 'putInOrder') {
      const settings = putInOrderSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);

      const validRows = await listTypedQuestionRows(
        settings.categoryIds,
        'put_in_order',
        { limit: settings.roundCount * 5 }
      );
      const validRounds = validRows.filter(({ payload }) => payload.items.length >= settings.itemsPerRound);
      const selected = pickRandom(
        ensureEnough(validRounds, settings.roundCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.roundCount
      );

      return {
        challengeType,
        title: getDefinitionTitle(challengeType, locale),
        description: getDefinitionDescription(challengeType, locale),
        roundCount: settings.roundCount,
        itemsPerRound: settings.itemsPerRound,
        rounds: selected.map(({ row, payload }) => {
          const subset = pickRandom(payload.items, settings.itemsPerRound);
          return {
            id: row.id,
            category: getQuestionCategory(row, locale),
            prompt: getLocalizedText(payload.prompt as Json, 'Put in order', locale),
            direction: payload.direction,
            items: shuffle(subset).map((item) => ({
              id: item.id,
              label: getLocalizedText(item.label as Json, 'Item', locale),
              details: item.details ? getLocalizedText(item.details as Json, '', locale) : null,
              emoji: item.emoji ?? null,
              sortValue: item.sort_value,
            })),
          };
        }),
      };
    }

    if (challengeType === 'imposter') {
      const settings = imposterSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);

      const validRows = await listTypedQuestionRows(
        settings.categoryIds,
        'imposter_multi_select',
        { limit: settings.questionCount * 5 }
      );
      const validQuestions = validRows.filter(({ row }) => getOptionalQuestionPrompt(row, locale) !== null);
      const selected = pickRandom(
        ensureEnough(validQuestions, settings.questionCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.questionCount
      );

      return {
        challengeType,
        title: getDefinitionTitle(challengeType, locale),
        description: getDefinitionDescription(challengeType, locale),
        questionCount: settings.questionCount,
        secondsPerQuestion: settings.secondsPerQuestion,
        questions: selected.map(({ row, payload }) => ({
          id: row.id,
          category: getQuestionCategory(row, locale),
          difficulty: row.difficulty,
          prompt: getQuestionPrompt(row, locale),
          options: payload.options.map((option) => ({
            id: option.id,
            text: getLocalizedText(option.text as Json, 'Option', locale),
          })),
          correctOptionIds: payload.options.filter((option) => option.is_correct).map((option) => option.id),
        })),
      };
    }

    if (challengeType === 'careerPath') {
      const settings = careerPathSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);

      const validRows = await listTypedQuestionRows(
        settings.categoryIds,
        'career_path',
        { limit: settings.questionCount * 5 }
      );
      const selected = pickRandom(
        ensureEnough(validRows, settings.questionCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.questionCount
      );

      return {
        challengeType,
        title: getDefinitionTitle(challengeType, locale),
        description: getDefinitionDescription(challengeType, locale),
        questionCount: settings.questionCount,
        secondsPerQuestion: settings.secondsPerQuestion,
        questions: selected.map(({ row, payload }) => {
          const clubs = payload.clubs.map((club) => getLocalizedText(club as Json, 'Club', locale));
          return {
            id: row.id,
            category: getQuestionCategory(row, locale),
            difficulty: row.difficulty,
            prompt: getQuestionPromptOrFallback(row, clubs.join(' ➔ '), locale),
            clubs,
            displayAnswer: getLocalizedText(payload.display_answer as Json, 'Answer', locale),
            acceptedAnswers: payload.accepted_answers,
          };
        }),
      };
    }

    if (challengeType === 'highLow') {
      const settings = highLowSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);

      const validRows = await listTypedQuestionRows(
        settings.categoryIds,
        'high_low',
        { limit: settings.roundCount * 5 }
      );
      const selected = pickRandom(
        ensureEnough(validRows, settings.roundCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.roundCount
      );

      return {
        challengeType,
        title: getDefinitionTitle(challengeType, locale),
        description: getDefinitionDescription(challengeType, locale),
        roundCount: settings.roundCount,
        secondsPerRound: settings.secondsPerRound,
        rounds: selected.map(({ row, payload }) => ({
          id: row.id,
          category: getQuestionCategory(row, locale),
          difficulty: row.difficulty,
          prompt: getQuestionPromptOrFallback(
            row,
            getLocalizedText(payload.stat_label as Json, 'High Low', locale),
            locale
          ),
          statLabel: getLocalizedText(payload.stat_label as Json, 'Stat', locale),
          matchups: payload.matchups.map((matchup) => ({
            id: matchup.id,
            leftName: getLocalizedText(matchup.left_name as Json, 'Left', locale),
            leftValue: matchup.left_value,
            rightName: getLocalizedText(matchup.right_name as Json, 'Right', locale),
            rightValue: matchup.right_value,
          })),
        })),
      };
    }

    const settings = footballLogicSettingsSchema.parse(config.settings);
    await ensureActiveCategories(config.challenge_type, settings.categoryIds);

    const validRows = await listTypedQuestionRows(
      settings.categoryIds,
      'football_logic',
      { limit: settings.questionCount * 5 }
    );
    const selected = pickRandom(
      ensureEnough(validRows, settings.questionCount, challengeType, { categoryIds: settings.categoryIds }),
      settings.questionCount
    );

    return {
      challengeType,
      title: getDefinitionTitle(challengeType, locale),
      description: getDefinitionDescription(challengeType, locale),
      questionCount: settings.questionCount,
      secondsPerQuestion: settings.secondsPerQuestion,
      questions: selected.map(({ row, payload }) => ({
        id: row.id,
        category: getQuestionCategory(row, locale),
        difficulty: row.difficulty,
        prompt: getOptionalQuestionPrompt(row, locale) ?? (payload.prompt ? getLocalizedText(payload.prompt as Json, 'Football Logic', locale) : null),
        imageAUrl: payload.image_a_url,
        imageBUrl: payload.image_b_url,
        displayAnswer: getLocalizedText(payload.display_answer as Json, 'Answer', locale),
        acceptedAnswers: payload.accepted_answers,
        explanation:
          payload.explanation
            ? getLocalizedText(payload.explanation as Json, '', locale)
            : getQuestionClue(row.explanation, locale),
      })),
    };
  },

  async completeChallenge(
    userId: string,
    challengeType: DailyChallengeType,
    score: number
  ) {
    const day = getUtcDay();
    const config = await dailyChallengesRepo.getConfig(challengeType);
    if (!config || !config.is_active) {
      throw new NotFoundError('Daily challenge not available');
    }

    return dailyChallengesRepo.runInTransaction(async (txRepo) => {
      const existing = await txRepo.getCompletionForUserOnDay(userId, challengeType, day);
      if (existing) {
        throwAlreadyCompleted(challengeType);
      }

      try {
        await txRepo.createCompletion({
          userId,
          challengeType,
          challengeDay: day,
          score,
          coinsAwarded: config.coin_reward,
          xpAwarded: config.xp_reward,
        });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
          throwAlreadyCompleted(challengeType);
        }
        throw error;
      }

      const wallet = await txRepo.addCoins(userId, config.coin_reward);
      await txRepo.grantXp({
        userId,
        sourceType: 'daily_challenge_completion',
        sourceKey: `${challengeType}:${day}`,
        xpDelta: config.xp_reward,
        metadata: {
          challengeType,
          challengeDay: day,
        },
      });

      return {
        challengeType,
        completedToday: true as const,
        coinsAwarded: config.coin_reward,
        xpAwarded: config.xp_reward,
        wallet: wallet
          ? {
              coins: wallet.coins,
              tickets: wallet.tickets,
            }
          : undefined,
      };
    });
  },

  assertDevResetAllowed(role: string | undefined): void {
    if (role !== 'admin') {
      throw new AuthorizationError('Access denied');
    }
  },

  async resetChallengeForToday(userId: string, challengeType: DailyChallengeType) {
    const day = getUtcDay();
    await dailyChallengesRepo.deleteCompletionForUserOnDay(userId, challengeType, day);

    return {
      challengeType,
      reset: true as const,
    };
  },
};
