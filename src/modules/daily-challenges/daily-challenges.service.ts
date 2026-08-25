import { createHash } from 'node:crypto';
import type { Json } from '../../db/types.js';
import { getOrLoadJson } from '../../core/json-cache.js';
import {
  AuthorizationError,
  DailyChallengeAlreadyCompletedError,
  DailyChallengeContentUnavailableError,
  NotFoundError,
  ValidationError,
} from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import { emailEnabled } from '../../core/email.js';
import { coinPartsToDisplay } from '../store/coin-amount.js';
import { getLocalizedString, mergeLocalizedAcceptedAnswers } from '../../lib/localization.js';
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

function getDailyChallengeDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function addUtcDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function consecutiveDailyStreakDays(completionDays: string[], throughDay: string): number {
  const completed = new Set(completionDays);
  let streak = 0;
  let cursor = throughDay;
  while (completed.has(cursor)) {
    streak += 1;
    cursor = addUtcDays(cursor, -1);
  }
  return streak;
}

function comebackBonusCoins(): number {
  return config.DAILY_COMEBACK_REWARDS_ENABLED
    ? config.DAILY_STREAK_BONUS_COINS
    : 0;
}

/** Tomorrow at 14:00 Georgia time (UTC+4, no DST). */
function nextDailyReminderAt(now = new Date()): Date {
  const geNow = new Date(now.getTime() + 4 * 60 * 60 * 1_000);
  const year = geNow.getUTCFullYear();
  const month = geNow.getUTCMonth();
  const day = geNow.getUTCDate() + 1;
  return new Date(Date.UTC(year, month, day, 10, 0, 0, 0));
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
const DAILY_CONTENT_CACHE_TTL_SECONDS = 30;

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

const RECENTLY_SERVED_WINDOW_DAYS = 14;

function normalizeAnswerString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return normalized || null;
}

function answerKeysOf(value: Json | null | undefined): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value)
    .map(normalizeAnswerString)
    .filter((key): key is string => key !== null);
}

// Random pick that (a) prefers questions the user hasn't been served recently —
// by question id AND by answer, so "Zidane again under a different question id"
// counts as seen — and (b) avoids serving two questions with the same answer in
// one session. All soft preferences: when the pool is too small the pick falls
// back to duplicates/recently-served rather than failing availability.
function pickChallengeQuestions<T>(
  items: T[],
  count: number,
  options: {
    idOf: (item: T) => string;
    recentlyServedIds?: Set<string>;
    recentlyServedAnswerKeys?: Set<string>;
    answerKeysOf?: (item: T) => string[];
  }
): T[] {
  const shuffled = shuffle(items);
  // tier 0: fresh question, fresh answer; tier 1: fresh question, recently
  // served answer; tier 2: recently served question. A candidate matches on
  // ANY of its locale keys, so differing locale coverage between history and
  // candidate ({en} vs {en,ka}) still counts as the same answer.
  const tierOf = (item: T): number => {
    if (options.recentlyServedIds?.has(options.idOf(item))) return 2;
    const answerKeys = options.answerKeysOf?.(item) ?? [];
    if (answerKeys.some((key) => options.recentlyServedAnswerKeys?.has(key))) return 1;
    return 0;
  };
  const ordered = options.recentlyServedIds?.size || options.recentlyServedAnswerKeys?.size
    ? [0, 1, 2].flatMap((tier) => shuffled.filter((item) => tierOf(item) === tier))
    : shuffled;

  const picked: T[] = [];
  const usedAnswerKeys = new Set<string>();
  const skipped: T[] = [];

  for (const item of ordered) {
    if (picked.length >= count) break;
    const answerKeys = options.answerKeysOf?.(item) ?? [];
    if (answerKeys.some((key) => usedAnswerKeys.has(key))) {
      skipped.push(item);
      continue;
    }
    answerKeys.forEach((key) => usedAnswerKeys.add(key));
    picked.push(item);
  }

  for (const item of skipped) {
    if (picked.length >= count) break;
    picked.push(item);
  }

  return shuffle(picked);
}

interface RecentlyServed {
  ids: Set<string>;
  answerKeys: Set<string>;
}

async function loadRecentlyServed(userId: string): Promise<RecentlyServed> {
  try {
    const rows = await dailyChallengesRepo.listRecentlyServedQuestions(userId, RECENTLY_SERVED_WINDOW_DAYS);
    const ids = new Set(rows.map((row) => row.question_id));
    const answerKeys = new Set(rows.flatMap((row) => row.answer_keys ?? []));
    return { ids, answerKeys };
  } catch (error) {
    logger.warn({ err: error, userId }, 'Failed to load recently served daily challenge questions');
    return { ids: new Set(), answerKeys: new Set() };
  }
}

function servedEntriesOf(
  selected: Array<{ row: { id: string }; payload: unknown }>
): Array<{ id: string; answerKeys: string[] }> {
  return selected.map(({ row, payload }) => ({
    id: row.id,
    answerKeys: answerKeysOf(((payload as { display_answer?: Json }).display_answer) ?? null),
  }));
}

async function markQuestionsServed(
  userId: string,
  served: Array<{ id: string; answerKeys: string[] }>
): Promise<void> {
  if (served.length === 0) return;
  try {
    await dailyChallengesRepo.recordServedQuestions(userId, served);
  } catch (error) {
    logger.warn({ err: error, userId }, 'Failed to record served daily challenge questions');
  }
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

/**
 * Coins paid per score point for each challenge type. Score semantics:
 * number of correct answers (trueFalse/imposter/careerPath/highLow),
 * answers found (countdown), or leftover budget (moneyDrop — paid 1:1,
 * capped at MONEY_DROP_COIN_CAP).
 */
const COINS_PER_SCORE_POINT: Record<DailyChallengeType, number> = {
  moneyDrop: 1, // leftover budget paid 1:1 (capped below)
  trueFalse: 200,
  countdown: 75,
  imposter: 500,
  careerPath: 300,
  highLow: 400,
  clues: 20,
  putInOrder: 20,
  footballLogic: 20,
};

const MONEY_DROP_COIN_CAP = 1500;

function getCoinsAwardedForCompletion(challengeType: DailyChallengeType, score: number): number {
  const normalizedScore = Math.max(0, Math.floor(score));

  if (challengeType === 'moneyDrop') {
    return Math.min(normalizedScore, MONEY_DROP_COIN_CAP);
  }

  return normalizedScore * COINS_PER_SCORE_POINT[challengeType];
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
    coinReward: completion?.coins_awarded ?? config.coin_reward,
    xpReward: config.xp_reward,
    showOnHome: config.show_on_home,
    completedToday: completion != null,
    availableToday: completion == null,
  };
}

async function listTypedQuestionRows<TType extends QuestionPayloadType>(
  categoryIds: string[],
  questionType: TType,
  options?: { limit?: number; excludeImagePayloads?: boolean }
): Promise<Array<{ row: QuestionContentRow; payload: PayloadOfType<TType> }>> {
  const cacheKey = sharedDailyContentKey(
    'rows',
    questionType,
    categoryIds,
    options?.limit,
    options?.excludeImagePayloads
  );
  const rows = await getOrLoadJson(cacheKey, DAILY_CONTENT_CACHE_TTL_SECONDS, () =>
    dailyChallengesRepo.listPublishedQuestionsByTypeAndCategories(
      questionType,
      categoryIds,
      options
    )
  );

  return rows
    .map((row) => {
      const payload = parsePayloadOfType(row, questionType);
      return payload ? { row, payload } : null;
    })
    .filter((item): item is { row: QuestionContentRow; payload: PayloadOfType<TType> } => item !== null);
}

function sharedDailyContentKey(
  kind: 'rows' | 'count',
  questionType: QuestionPayloadType,
  categoryIds: string[],
  limit?: number,
  excludeImagePayloads?: boolean
): string {
  const identity = JSON.stringify([
    questionType,
    [...categoryIds].sort(),
    limit ?? null,
    excludeImagePayloads ?? false,
  ]);
  const digest = createHash('sha256').update(identity).digest('hex');
  return `daily:content:v1:${kind}:${digest}`;
}

async function countPublishedQuestions(
  questionType: QuestionPayloadType,
  categoryIds: string[]
): Promise<number> {
  const cacheKey = sharedDailyContentKey('count', questionType, categoryIds);
  return getOrLoadJson(cacheKey, DAILY_CONTENT_CACHE_TTL_SECONDS, () =>
    dailyChallengesRepo.countPublishedQuestionsByTypeAndCategories(questionType, categoryIds)
  );
}

async function getContentAvailabilityDetails<TType extends QuestionPayloadType>(
  categoryIds: string[],
  questionType: TType,
  validRows: Array<{ row: QuestionContentRow; payload: PayloadOfType<TType> }>
): Promise<ContentAvailabilityDetails> {
  const rawPublishedInSelectedCategories =
    await countPublishedQuestions(questionType, categoryIds);

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
    await countPublishedQuestions(questionType, []);

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
    const day = getDailyChallengeDay();
    const [configs, completions] = await Promise.all([
      dailyChallengesRepo.listConfigs(true),
      dailyChallengesRepo.listCompletionsForUserOnDay(userId, day),
    ]);
    const knownConfigs = configs.filter(isKnownDailyChallengeConfig);
    const completionByType = new Map(completions.map((item) => [item.challenge_type, item]));

    return knownConfigs.map((config) => toListItem(config, completionByType.get(config.challenge_type), locale));
  },

  async getComebackState(userId: string) {
    const today = getDailyChallengeDay();
    const [completionDays, reminder, canReceiveReminder] = await Promise.all([
      dailyChallengesRepo.listDistinctCompletionDays(userId, today),
      dailyChallengesRepo.getPendingReminder(userId),
      dailyChallengesRepo.canReceiveReminderEmail(userId),
    ]);
    const projectedDays = completionDays.includes(today)
      ? completionDays
      : [today, ...completionDays];

    return {
      projectedStreakDays: consecutiveDailyStreakDays(projectedDays, today),
      tomorrowBonusCoins: comebackBonusCoins(),
      rewardEnabled: config.DAILY_COMEBACK_REWARDS_ENABLED,
      remindersEnabled: config.DAILY_REMINDERS_ENABLED && emailEnabled() && canReceiveReminder,
      reminderScheduled: reminder != null,
      reminderAt: reminder?.remind_at ?? null,
    };
  },

  async setComebackReminder(userId: string, enabled: boolean) {
    if (!enabled) {
      await dailyChallengesRepo.cancelReminder(userId);
      return { enabled: false as const, reminderAt: null };
    }
    if (
      !config.DAILY_REMINDERS_ENABLED
      || !emailEnabled()
      || !await dailyChallengesRepo.canReceiveReminderEmail(userId)
    ) {
      throw new ValidationError('Daily Challenge reminders are not enabled');
    }
    const reminder = await dailyChallengesRepo.upsertReminder(userId, nextDailyReminderAt());
    return { enabled: true as const, reminderAt: reminder.remind_at };
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
    const day = getDailyChallengeDay();
    const config = await dailyChallengesRepo.getConfig(challengeType);
    if (!config || !config.is_active) {
      throw new NotFoundError('Daily challenge not available');
    }

    const completion = await dailyChallengesRepo.getCompletionForUserOnDay(userId, challengeType, day);
    if (completion) {
      throwAlreadyCompleted(challengeType);
    }

    const recentlyServed = await loadRecentlyServed(userId);

    if (challengeType === 'moneyDrop') {
      const settings = moneyDropSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);

      // Image MCQs publish as plain mcq_single, but their stem references the
      // photo ("who is pictured…") and this response schema carries no image —
      // served here they'd be unanswerable. Ranked renders the image; Money
      // Drop must skip them (359 published image MCQs sat in this pool).
      // Excluded in SQL, BEFORE the sample limit — a post-limit filter could
      // come up short in image-heavy categories. The in-memory check stays as
      // a belt-and-braces guard for cached rows.
      const validRows = await listTypedQuestionRows(
        settings.categoryIds,
        'mcq_single',
        { limit: settings.questionCount * 5, excludeImagePayloads: true }
      );
      const validQuestions = validRows.filter(
        ({ row, payload }) =>
          getOptionalQuestionPrompt(row, locale) !== null &&
          (payload as { image?: unknown }).image == null
      );
      const selected = pickChallengeQuestions(
        ensureEnough(validQuestions, settings.questionCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.questionCount,
        { idOf: ({ row }) => row.id, recentlyServedIds: recentlyServed.ids }
      );
      await markQuestionsServed(userId, servedEntriesOf(selected));

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
      const selected = pickChallengeQuestions(
        ensureEnough(validRows, settings.questionCount, challengeType, availabilityDetails),
        settings.questionCount,
        { idOf: ({ row }) => row.id, recentlyServedIds: recentlyServed.ids }
      );
      await markQuestionsServed(userId, servedEntriesOf(selected));

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
      const selected = pickChallengeQuestions(
        ensureEnough(validRows, settings.roundCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.roundCount,
        { idOf: ({ row }) => row.id, recentlyServedIds: recentlyServed.ids }
      );
      await markQuestionsServed(userId, servedEntriesOf(selected));

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
            acceptedAnswers: mergeLocalizedAcceptedAnswers(group.accepted_answers, group.display as Json),
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
        // 20x: the pool holds many questions per player, so a 5x random sample
        // can be crowded by duplicated answers before tiering ever runs
        { limit: settings.questionCount * 20 }
      );
      const selected = pickChallengeQuestions(
        ensureEnough(validRows, settings.questionCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.questionCount,
        {
          idOf: ({ row }) => row.id,
          recentlyServedIds: recentlyServed.ids,
          recentlyServedAnswerKeys: recentlyServed.answerKeys,
          answerKeysOf: ({ payload }) => answerKeysOf(payload.display_answer as Json),
        }
      );
      await markQuestionsServed(userId, servedEntriesOf(selected));

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
          acceptedAnswers: mergeLocalizedAcceptedAnswers(payload.accepted_answers, payload.display_answer as Json),
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
      const selected = pickChallengeQuestions(
        ensureEnough(validRounds, settings.roundCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.roundCount,
        { idOf: ({ row }) => row.id, recentlyServedIds: recentlyServed.ids }
      );
      await markQuestionsServed(userId, servedEntriesOf(selected));

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
      const selected = pickChallengeQuestions(
        ensureEnough(validQuestions, settings.questionCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.questionCount,
        { idOf: ({ row }) => row.id, recentlyServedIds: recentlyServed.ids }
      );
      await markQuestionsServed(userId, servedEntriesOf(selected));

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
        { limit: settings.questionCount * 20 }
      );
      const selected = pickChallengeQuestions(
        ensureEnough(validRows, settings.questionCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.questionCount,
        {
          idOf: ({ row }) => row.id,
          recentlyServedIds: recentlyServed.ids,
          recentlyServedAnswerKeys: recentlyServed.answerKeys,
          answerKeysOf: ({ payload }) => answerKeysOf(payload.display_answer as Json),
        }
      );
      await markQuestionsServed(userId, servedEntriesOf(selected));

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
            acceptedAnswers: mergeLocalizedAcceptedAnswers(payload.accepted_answers, payload.display_answer as Json),
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
      const selected = pickChallengeQuestions(
        ensureEnough(validRows, settings.roundCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.roundCount,
        { idOf: ({ row }) => row.id, recentlyServedIds: recentlyServed.ids }
      );
      await markQuestionsServed(userId, servedEntriesOf(selected));

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
      { limit: settings.questionCount * 20 }
    );
    const selected = pickChallengeQuestions(
      ensureEnough(validRows, settings.questionCount, challengeType, { categoryIds: settings.categoryIds }),
      settings.questionCount,
      {
        idOf: ({ row }) => row.id,
        recentlyServedIds: recentlyServed.ids,
        recentlyServedAnswerKeys: recentlyServed.answerKeys,
        answerKeysOf: ({ payload }) => answerKeysOf(payload.display_answer as Json),
      }
    );
    await markQuestionsServed(userId, servedEntriesOf(selected));

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
        acceptedAnswers: mergeLocalizedAcceptedAnswers(payload.accepted_answers, payload.display_answer as Json),
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
    const day = getDailyChallengeDay();
    const config = await dailyChallengesRepo.getConfig(challengeType);
    if (!config || !config.is_active) {
      throw new NotFoundError('Daily challenge not available');
    }
    const coinsAwarded = getCoinsAwardedForCompletion(challengeType, score);
    const configuredStreakBonus = comebackBonusCoins();

    return dailyChallengesRepo.runInTransaction(async (txRepo) => {
      const existing = await txRepo.getCompletionForUserOnDay(userId, challengeType, day);
      if (existing) {
        throwAlreadyCompleted(challengeType);
      }

      const completionDaysBefore = await txRepo.listDistinctCompletionDays(userId, day, 370);

      try {
        await txRepo.createCompletion({
          userId,
          challengeType,
          challengeDay: day,
          score,
          coinsAwarded,
          xpAwarded: config.xp_reward,
        });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
          throwAlreadyCompleted(challengeType);
        }
        throw error;
      }

      const completedYesterday = completionDaysBefore.includes(addUtcDays(day, -1));
      const streakBonusAwarded = completedYesterday && configuredStreakBonus > 0
        && await txRepo.createStreakBonusAward(userId, day, configuredStreakBonus)
        ? configuredStreakBonus
        : 0;
      const wallet = await txRepo.addCoins(userId, coinsAwarded + streakBonusAwarded);
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

      const completionDaysAfter = completionDaysBefore.includes(day)
        ? completionDaysBefore
        : [day, ...completionDaysBefore];

      return {
        challengeType,
        completedToday: true as const,
        coinsAwarded,
        streakBonusAwarded,
        dailyStreakDays: consecutiveDailyStreakDays(completionDaysAfter, day),
        nextStreakBonusCoins: configuredStreakBonus,
        xpAwarded: config.xp_reward,
        wallet: wallet
          ? {
              coins: wallet.coin_fraction_minor == null
                ? wallet.coins
                : coinPartsToDisplay(wallet.coins, wallet.coin_fraction_minor),
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
    const day = getDailyChallengeDay();
    await dailyChallengesRepo.deleteCompletionForUserOnDay(userId, challengeType, day);

    return {
      challengeType,
      reset: true as const,
    };
  },
};
