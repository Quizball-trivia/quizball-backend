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
import { questionPayloadSchema } from '../questions/questions.schemas.js';
import { DAILY_CHALLENGE_DEFINITIONS } from './daily-challenges.definitions.js';
import { dailyChallengesRepo } from './daily-challenges.repo.js';
import {
  cluesSettingsSchema,
  countdownSettingsSchema,
  footballJeopardySettingsSchema,
  moneyDropSettingsSchema,
  type DailyChallengeSettings,
  putInOrderSettingsSchema,
  trueFalseSettingsSchema,
} from './daily-challenges.schemas.js';
import type {
  DailyChallengeCompletionRow,
  DailyChallengeConfigRow,
  DailyChallengeType,
  QuestionContentRow,
} from './daily-challenges.types.js';

function getUtcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const dailyChallengeSettingsSchemas = {
  moneyDrop: moneyDropSettingsSchema,
  footballJeopardy: footballJeopardySettingsSchema,
  trueFalse: trueFalseSettingsSchema,
  countdown: countdownSettingsSchema,
  clues: cluesSettingsSchema,
  putInOrder: putInOrderSettingsSchema,
} as const;

function throwAlreadyCompleted(challengeType: DailyChallengeType): never {
  throw new DailyChallengeAlreadyCompletedError({ challengeType });
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
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
  details: unknown
): T[] {
  if (items.length < needed) {
    throw new DailyChallengeContentUnavailableError({
      challengeType,
      needed,
      available: items.length,
      ...((details ?? {}) as Record<string, unknown>),
    });
  }
  return items;
}

async function ensureActiveCategories(
  challengeType: DailyChallengeType,
  categoryIds: string[]
): Promise<void> {
  if (categoryIds.length === 0) return;
  const categories = await categoriesRepo.listByIds(categoryIds);
  const activeIds = new Set(categories.filter((row) => row.is_active).map((row) => row.id));
  const invalidIds = categoryIds.filter((id) => !activeIds.has(id));
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

function parsePayload(row: QuestionContentRow) {
  const parsed = questionPayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

function toListItem(config: DailyChallengeConfigRow, completion: DailyChallengeCompletionRow | undefined) {
  const definition = getDefinition(config.challenge_type);
  return {
    challengeType: config.challenge_type,
    title: definition.title,
    description: definition.description,
    iconToken: definition.iconToken,
    coinReward: config.coin_reward,
    xpReward: config.xp_reward,
    showOnHome: config.show_on_home,
    completedToday: completion != null,
    availableToday: completion == null,
  };
}

function getQuestionCategory(row: QuestionContentRow): string {
  return getLocalizedString(row.category_name, { fallback: 'Football' });
}

function getLegacyPayloadPrompt(payload: Json | null): string | null {
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
    const localized = getLocalizedString(promptValue as Json, { fallback: '' }).trim();
    return localized.length > 0 ? localized : null;
  }

  return null;
}

function getQuestionPrompt(row: QuestionContentRow): string {
  const prompt = getLocalizedString(row.prompt, { fallback: '' }).trim();
  if (prompt.length > 0) {
    return prompt;
  }

  const legacyPrompt = getLegacyPayloadPrompt(row.payload);
  if (legacyPrompt) {
    return legacyPrompt;
  }

  return 'Question';
}

function getQuestionClue(explanation: Json | null): string | null {
  if (!explanation) {
    return null;
  }
  const clue = getLocalizedString(explanation, { fallback: '' }).trim();
  return clue.length > 0 ? clue : null;
}

function hasUsableQuestionPrompt(row: QuestionContentRow): boolean {
  return getQuestionPrompt(row) !== 'Question';
}

export const dailyChallengesService = {
  async listActiveChallenges(userId: string) {
    const day = getUtcDay();
    const [configs, completions] = await Promise.all([
      dailyChallengesRepo.listConfigs(true),
      dailyChallengesRepo.listCompletionsForUserOnDay(userId, day),
    ]);
    const completionByType = new Map(completions.map((item) => [item.challenge_type, item]));
    return configs
      .filter((config) => config.challenge_type !== 'trueFalse')
      .map((config) => toListItem(config, completionByType.get(config.challenge_type)));
  },

  async listAdminConfigs() {
    const configs = await dailyChallengesRepo.listConfigs(false);
    return configs.map((config) => ({
      ...toListItem(config, undefined),
      isActive: config.is_active,
      sortOrder: config.sort_order,
      settings: this.parseSettings(config.challenge_type, config.settings),
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
    await ensureActiveCategories(challengeType, this.extractCategoryIds(challengeType, settings));

    const config = await dailyChallengesRepo.upsertConfig({
      challengeType,
      ...input,
      settings,
    });

    return {
      ...toListItem(config, undefined),
      isActive: config.is_active,
      sortOrder: config.sort_order,
      settings: config.settings,
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

  async getChallengeSession(userId: string, challengeType: DailyChallengeType) {
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
      const rows = await dailyChallengesRepo.listPublishedQuestionsByTypeAndCategories('mcq_single', settings.categoryIds, { limit: settings.questionCount * 5 });
      const valid = rows
        .map((row) => ({ row, payload: parsePayload(row) }))
        .filter((item): item is { row: QuestionContentRow; payload: Extract<ReturnType<typeof parsePayload>, { type: 'mcq_single' }> } => item.payload?.type === 'mcq_single')
        .filter((item) => hasUsableQuestionPrompt(item.row));
      const selected = pickRandom(
        ensureEnough(valid, settings.questionCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.questionCount
      );

      return {
        challengeType,
        title: getDefinition(challengeType).title,
        description: getDefinition(challengeType).description,
        questionCount: settings.questionCount,
        secondsPerQuestion: settings.secondsPerQuestion,
        startingMoney: settings.startingMoney,
        questions: selected.map(({ row, payload }) => ({
          id: row.id,
          category: getQuestionCategory(row),
          difficulty: row.difficulty,
          prompt: getQuestionPrompt(row),
          options: payload.options.map((option) => getLocalizedString(option.text, { fallback: 'Option' })),
          correctAnswerIndex: payload.options.findIndex((option) => option.is_correct),
          clue: getQuestionClue(row.explanation),
        })),
      };
    }

    if (challengeType === 'footballJeopardy') {
      const settings = footballJeopardySettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);
      const rows = await dailyChallengesRepo.listPublishedQuestionsByTypeAndCategories('mcq_single', settings.categoryIds);
      const valid = rows
        .map((row) => ({ row, payload: parsePayload(row) }))
        .filter((item): item is { row: QuestionContentRow; payload: Extract<ReturnType<typeof parsePayload>, { type: 'mcq_single' }> } => item.payload?.type === 'mcq_single')
        .filter((item) => hasUsableQuestionPrompt(item.row));
      const byCategory = new Map<string, typeof valid>();
      for (const item of valid) {
        byCategory.set(item.row.category_id, [...(byCategory.get(item.row.category_id) ?? []), item]);
      }

      const resolvedCategoryIds = settings.categoryIds.length > 0
        ? settings.categoryIds
        : [...byCategory.keys()];
      const eligibleCategoryIds = resolvedCategoryIds.filter((categoryId) => {
        const categoryRows = byCategory.get(categoryId) ?? [];
        return categoryRows.some((item) => item.row.difficulty === 'easy')
          && categoryRows.some((item) => item.row.difficulty === 'medium')
          && categoryRows.some((item) => item.row.difficulty === 'hard');
      });
      const selectedCategoryIds = pickRandom(
        ensureEnough(eligibleCategoryIds, 1, challengeType, {
          configuredCategoryIds: settings.categoryIds,
          resolvedCategoryIds,
          pickCount: settings.pickCount,
        }),
        Math.min(settings.pickCount, eligibleCategoryIds.length)
      );

      const categories = selectedCategoryIds.map((categoryId) => {
        const categoryRows = byCategory.get(categoryId) ?? [];
        const easy = pickRandom(categoryRows.filter((item) => item.row.difficulty === 'easy'), 1)[0];
        const medium = pickRandom(categoryRows.filter((item) => item.row.difficulty === 'medium'), 1)[0];
        const hard = pickRandom(categoryRows.filter((item) => item.row.difficulty === 'hard'), 1)[0];
        if (!easy || !medium || !hard) {
          throw new DailyChallengeContentUnavailableError({ challengeType, categoryId });
        }
        const selected = [
          { value: 100 as const, item: easy },
          { value: 200 as const, item: medium },
          { value: 300 as const, item: hard },
        ];
        return {
          id: categoryId,
          name: getQuestionCategory(selected[0].item.row),
          questions: selected.map(({ value, item }) => ({
            id: item.row.id,
            value,
            difficulty: item.row.difficulty,
            prompt: getQuestionPrompt(item.row),
            options: item.payload.options.map((option) => getLocalizedString(option.text, { fallback: 'Option' })),
            correctAnswerIndex: item.payload.options.findIndex((option) => option.is_correct),
            clue: getQuestionClue(item.row.explanation),
          })),
        };
      });

      return {
        challengeType,
        title: getDefinition(challengeType).title,
        description: getDefinition(challengeType).description,
        pickCount: settings.pickCount,
        categories,
      };
    }

    if (challengeType === 'trueFalse') {
      throw new NotFoundError('Daily challenge not available');
    }

    if (challengeType === 'countdown') {
      const settings = countdownSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);
      const rows = await dailyChallengesRepo.listPublishedQuestionsByTypeAndCategories('countdown_list', settings.categoryIds, { limit: settings.roundCount * 5 });
      const valid = rows
        .map((row) => ({ row, payload: parsePayload(row) }))
        .filter((item): item is { row: QuestionContentRow; payload: Extract<ReturnType<typeof parsePayload>, { type: 'countdown_list' }> } => item.payload?.type === 'countdown_list');
      const selected = pickRandom(
        ensureEnough(valid, settings.roundCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.roundCount
      );

      return {
        challengeType,
        title: getDefinition(challengeType).title,
        description: getDefinition(challengeType).description,
        roundCount: settings.roundCount,
        secondsPerRound: settings.secondsPerRound,
        rounds: selected.map(({ row, payload }) => ({
          id: row.id,
          category: getQuestionCategory(row),
          prompt: getLocalizedString(payload.prompt, { fallback: 'Countdown' }),
          answerGroups: payload.answer_groups.map((group) => ({
            id: group.id,
            display: getLocalizedString(group.display as Json, { fallback: 'Answer' }),
            acceptedAnswers: group.accepted_answers,
          })),
        })),
      };
    }

    if (challengeType === 'clues') {
      const settings = cluesSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);
      const rows = await dailyChallengesRepo.listPublishedQuestionsByTypeAndCategories('clue_chain', settings.categoryIds, { limit: settings.questionCount * 5 });
      const valid = rows
        .map((row) => ({ row, payload: parsePayload(row) }))
        .filter((item): item is { row: QuestionContentRow; payload: Extract<ReturnType<typeof parsePayload>, { type: 'clue_chain' }> } => item.payload?.type === 'clue_chain');
      const selected = pickRandom(
        ensureEnough(valid, settings.questionCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.questionCount
      );

      return {
        challengeType,
        title: getDefinition(challengeType).title,
        description: getDefinition(challengeType).description,
        questionCount: settings.questionCount,
        secondsPerClueStep: settings.secondsPerClueStep,
        questions: selected.map(({ row, payload }) => ({
          id: row.id,
          category: getQuestionCategory(row),
          difficulty: row.difficulty,
          displayAnswer: getLocalizedString(payload.display_answer, { fallback: 'Answer' }),
          acceptedAnswers: payload.accepted_answers,
          clues: payload.clues.map((clue) => ({
            type: clue.type,
            content: getLocalizedString(clue.content as Json, { fallback: 'Clue' }),
          })),
        })),
      };
    }

    const settings = putInOrderSettingsSchema.parse(config.settings);
    await ensureActiveCategories(config.challenge_type, settings.categoryIds);
    const rows = await dailyChallengesRepo.listPublishedQuestionsByTypeAndCategories('put_in_order', settings.categoryIds, { limit: settings.roundCount * 5 });
    const valid = rows
      .map((row) => ({ row, payload: parsePayload(row) }))
      .filter((item): item is { row: QuestionContentRow; payload: Extract<ReturnType<typeof parsePayload>, { type: 'put_in_order' }> } => item.payload?.type === 'put_in_order')
      .filter((item) => item.payload.items.length >= settings.itemsPerRound);
    const selected = pickRandom(
      ensureEnough(valid, settings.roundCount, challengeType, { categoryIds: settings.categoryIds }),
      settings.roundCount
    );

    return {
      challengeType,
      title: getDefinition(challengeType).title,
      description: getDefinition(challengeType).description,
      roundCount: settings.roundCount,
      itemsPerRound: settings.itemsPerRound,
      rounds: selected.map(({ row, payload }) => {
        const subset = pickRandom(payload.items, settings.itemsPerRound);
        return {
          id: row.id,
          category: getQuestionCategory(row),
          prompt: getLocalizedString(payload.prompt, { fallback: 'Put in order' }),
          direction: payload.direction,
          items: shuffle(subset).map((item) => ({
            id: item.id,
            label: getLocalizedString(item.label as Json, { fallback: 'Item' }),
            details: item.details ? getLocalizedString(item.details as Json, { fallback: '' }) : null,
            emoji: item.emoji ?? null,
            sortValue: item.sort_value,
          })),
        };
      }),
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
