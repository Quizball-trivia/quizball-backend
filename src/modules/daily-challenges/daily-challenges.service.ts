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
import { rankDailyChallenges } from './daily-challenges.recommendations.js';
import { dailyChallengesRepo, type PassChainPlayerRow } from './daily-challenges.repo.js';
import {
  careerPathSettingsSchema,
  cluesSettingsSchema,
  countdownSettingsSchema,
  fifaCardsSettingsSchema,
  cardDetectiveSettingsSchema,
  footballLogicSettingsSchema,
  missingXiSettingsSchema,
  passChainSettingsSchema,
  statSniperSettingsSchema,
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
  DailyChallengeCardOutcomeInput,
  DailyChallengeCompletionRow,
  DailyChallengeConfigRow,
  DailyChallengeLocalizedText,
  DailyChallengeType,
  FifaCardRow,
  DailyFifaCardSetRow,
  QuestionContentRow,
} from './daily-challenges.types.js';
import { buildFifaFaceUrl } from './fifa-face-url.js';
import { guestRepo } from '../guest/guest.repo.js';

/** Placeholder actor for guest set building: never written anywhere (no served-history, no completion). */
const GUEST_ACTOR = '00000000-0000-4000-8000-000000000000';
const guestSetKey = (day: string, type: string, locale?: string) => `guest:daily:v1:${day}:${type}:${locale ?? 'en'}`;
const guestSetMemo = new Map<string, { value: unknown; expiresAt: number }>();
function secondsUntilNextUtcDay(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.floor((next - now.getTime()) / 1000));
}

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
  missingXi: missingXiSettingsSchema,
  passChain: passChainSettingsSchema,
  statSniper: statSniperSettingsSchema,
  fifaCards: fifaCardsSettingsSchema,
  cardDetective: cardDetectiveSettingsSchema,
} as const;

const SUPPORTED_DAILY_CHALLENGE_LOCALES = ['en', 'ka', 'es'] as const;
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
  if (normalized === 'es' || normalized.startsWith('es-')) {
    return 'es';
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

// Owner decision 2026-09-05: a Football Logic round is 60% easy, 20% medium,
// 20% hard (3-1-1 at five questions); rounding leftovers go to easy.
function footballLogicDifficultyQuota(count: number): Record<string, number> {
  const medium = Math.floor(count * 0.2);
  const hard = Math.floor(count * 0.2);
  return { easy: count - medium - hard, medium, hard };
}

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
    // Per-difficulty quota (e.g. 4 easy / 3 medium / 3 hard). Soft: when a
    // tier runs dry the remaining slots are filled from whatever is left.
    difficultyQuota?: Record<string, number>;
    difficultyOf?: (item: T) => string;
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
  const remainingQuota = options.difficultyQuota ? { ...options.difficultyQuota } : null;

  for (const item of ordered) {
    if (picked.length >= count) break;
    const answerKeys = options.answerKeysOf?.(item) ?? [];
    if (answerKeys.some((key) => usedAnswerKeys.has(key))) {
      skipped.push(item);
      continue;
    }
    if (remainingQuota && options.difficultyOf) {
      const difficulty = options.difficultyOf(item);
      if ((remainingQuota[difficulty] ?? 0) <= 0) {
        skipped.push(item);
        continue;
      }
      remainingQuota[difficulty] -= 1;
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

function servedEntriesOf<T extends { row: { id: string }; payload: unknown }>(
  selected: T[],
  // Types without a display_answer record the same keys their selection dedupes on.
  keysOf: (entry: T) => string[] = ({ payload }) => answerKeysOf(((payload as { display_answer?: Json }).display_answer) ?? null),
): Array<{ id: string; answerKeys: string[] }> {
  return selected.map((entry) => ({ id: entry.row.id, answerKeys: keysOf(entry) }));
}

/**
 * Deterministic daily pick: every player gets the same questions on the same day
 * (a leaderboard needs identical papers) and restarting cannot reroll them.
 */
function pickDaySeeded<T>(rows: T[], count: number, day: string, idOf: (row: T) => string, difficultyOf: (row: T) => string, quota: Record<string, number>): T[] {
  const ordered = rows
    .map((row) => ({ row, key: createHash('sha1').update(`${day}:${idOf(row)}`).digest('hex') }))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((x) => x.row);
  const picked: T[] = [];
  for (const [difficulty, wanted] of Object.entries(quota)) {
    for (const row of ordered) {
      if (picked.length >= count) break;
      if (picked.filter((p) => difficultyOf(p) === difficulty).length >= wanted) break;
      if (difficultyOf(row) === difficulty && !picked.includes(row)) picked.push(row);
    }
  }
  for (const row of ordered) { if (picked.length >= count) break; if (!picked.includes(row)) picked.push(row); }
  return picked.slice(0, count);
}

async function markQuestionsServedForUser(
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

const FIFA_CARDS_POINTS_PER_SOLVE = 10;
const FIFA_CARDS_ROTATION_SALT = 'fifa-cards-rotation-v1';
const FIFA_CARDS_MAX_CLUES = 3;

/** Card Detective: every card starts with 100 clue coins; a solve scores what is left. */
export const CARD_DETECTIVE_START_COINS = 100;
export const CARD_DETECTIVE_WRONG_GUESS_COST = 15;
export const CARD_DETECTIVE_CLUE_COSTS = {
  rating: 25,
  club: 20,
  league: 15,
  nation: 10,
  position: 10,
  pac: 5, sho: 5, pas: 5, dri: 5, def: 5, phy: 5,
} as const;
const CARD_DETECTIVE_MAX_CLUES = Object.keys(CARD_DETECTIVE_CLUE_COSTS).length;
const CARD_DETECTIVE_ROTATION_SALT = 'card-detective-rotation-v1';

type CardSetType = 'fifaCards' | 'cardDetective';
const isCardSetType = (type: DailyChallengeType): type is CardSetType => type === 'fifaCards' || type === 'cardDetective';
const CARD_SET_REPO: Record<CardSetType, {
  get: (day: string) => Promise<DailyFifaCardSetRow | null>;
  allocate: (day: string, count: number, salt: string) => Promise<DailyFifaCardSetRow>;
  salt: string;
}> = {
  fifaCards: {
    get: (day) => dailyChallengesRepo.getDailyFifaCardSet(day),
    allocate: (day, count, salt) => dailyChallengesRepo.allocateDailyFifaCardSet(day, count, salt),
    salt: FIFA_CARDS_ROTATION_SALT,
  },
  cardDetective: {
    get: (day) => dailyChallengesRepo.getDailyCardDetectiveSet(day),
    allocate: (day, count, salt) => dailyChallengesRepo.allocateDailyCardDetectiveSet(day, count, salt),
    salt: CARD_DETECTIVE_ROTATION_SALT,
  },
};

/**
 * Everyone plays the same cards on a given (UTC) day. The set is materialised on
 * the day's first request from never-served cards (stable salted-hash order),
 * recycling least-recently-served cards only once the pool is exhausted; a
 * concurrent first request loses the insert race harmlessly and re-reads.
 */
async function getOrCreateDailyCardSet(
  day: string,
  count: number,
  challengeType: CardSetType
): Promise<FifaCardRow[]> {
  const repo = CARD_SET_REPO[challengeType];
  const set = (await repo.get(day)) ?? (await repo.allocate(day, count, repo.salt));
  // A short pool still yields a playable (smaller) round; an empty one is a
  // content outage, reported like any other type's missing content.
  ensureEnough(set.card_ids, 1, challengeType, { needed: count, challengeDay: day });

  const rows = await dailyChallengesRepo.listFifaCardsByIds(set.card_ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = set.card_ids.map((id) => byId.get(id));
  if (ordered.some((row) => row == null) || new Set(set.card_ids).size !== set.card_ids.length) {
    // Dangling or duplicate ids in a stored set mean the row was hand-edited
    // badly; refuse to serve a half-set rather than silently shrinking it.
    throw new DailyChallengeContentUnavailableError({ challengeType, challengeDay: day, reason: 'corrupt_daily_set' });
  }
  return ordered as FifaCardRow[];
}

function toFifaSessionCard(card: FifaCardRow, locale?: string) {
  const name = locale === 'ka' && card.name_ka ? card.name_ka : card.name;
  const acceptedAnswers = Array.from(
    new Set([card.name, card.name_ka ?? '', ...card.accepted].map((value) => value.trim()).filter(Boolean))
  );
  return {
    id: card.id,
    edition: card.edition,
    editionLabel: card.edition_label,
    name,
    acceptedAnswers,
    overall: card.overall,
    position: card.position,
    nation: card.nation,
    nationCode: card.nation_code,
    league: card.league,
    club: card.club,
    stats: { pac: card.pac, sho: card.sho, pas: card.pas, dri: card.dri, def: card.def, phy: card.phy },
    faceUrl: buildFifaFaceUrl(card.photo_id, card.photo_ver),
    difficulty: card.difficulty,
  };
}

/**
 * Card-based completions (FIFA Cards, Card Detective) are only accepted with one
 * outcome per card of today's served set — no missing, unknown or duplicate
 * cards — and the score is derived from the reported outcomes rather than
 * taken from the client: solves × 10 for FIFA Cards, clue coins left on solved
 * cards for Card Detective. Without a served set there is nothing to complete.
 * (The individual `solved` / `coinsLeft` values are still client-reported and
 * bounded by the type's ceiling; server-side guess validation is a
 * platform-wide follow-up shared with every other daily type.)
 */
async function reconcileCardOutcomes(
  challengeType: DailyChallengeType,
  day: string,
  score: number,
  outcomes: DailyChallengeCardOutcomeInput[] | undefined
): Promise<{ score: number; outcomes: DailyChallengeCardOutcomeInput[] }> {
  if (challengeType !== 'fifaCards' && challengeType !== 'cardDetective') {
    return { score, outcomes: [] };
  }
  const label = challengeType === 'fifaCards' ? 'FIFA Cards' : 'Card Detective';
  const set = await CARD_SET_REPO[challengeType].get(day);
  if (!set || set.card_ids.length === 0) {
    throw new ValidationError(`No ${label} set has been served today`, { challengeDay: day });
  }
  if (!outcomes || outcomes.length !== set.card_ids.length) {
    throw new ValidationError(`${label} completion must report one outcome per card in today's set`, {
      expected: set.card_ids.length,
      received: outcomes?.length ?? 0,
    });
  }
  const allowed = new Set(set.card_ids);
  const seen = new Set<string>();
  const maxClues = challengeType === 'fifaCards' ? FIFA_CARDS_MAX_CLUES : CARD_DETECTIVE_MAX_CLUES;
  for (const outcome of outcomes) {
    if (!allowed.has(outcome.cardId)) {
      throw new ValidationError("Outcome references a card that is not in today's set", { cardId: outcome.cardId });
    }
    if (seen.has(outcome.cardId)) {
      throw new ValidationError('Duplicate card outcome', { cardId: outcome.cardId });
    }
    if (outcome.cluesRevealed > maxClues) {
      throw new ValidationError('Too many clues revealed for this challenge', { cardId: outcome.cardId, max: maxClues });
    }
    seen.add(outcome.cardId);
  }

  if (challengeType === 'fifaCards') {
    const solved = outcomes.filter((outcome) => outcome.solved).length;
    return {
      score: solved * FIFA_CARDS_POINTS_PER_SOLVE,
      outcomes: outcomes.map((outcome) => ({ cardId: outcome.cardId, solved: outcome.solved, cluesRevealed: outcome.cluesRevealed })),
    };
  }

  // Card Detective: each outcome must say how many clue coins were left; an
  // unsolved card scores nothing regardless.
  let total = 0;
  const normalized = outcomes.map((outcome) => {
    const coinsLeft = outcome.coinsLeft;
    if (coinsLeft == null || !Number.isInteger(coinsLeft) || coinsLeft < 0 || coinsLeft > CARD_DETECTIVE_START_COINS) {
      throw new ValidationError('Card Detective outcomes must report coins left (0..100)', { cardId: outcome.cardId });
    }
    if (outcome.solved) total += coinsLeft;
    return { cardId: outcome.cardId, solved: outcome.solved, cluesRevealed: outcome.cluesRevealed, coinsLeft };
  });
  return { score: total, outcomes: normalized };
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

function getQuestionTypeForChallenge(challengeType: DailyChallengeType): QuestionType | null {
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
    case 'missingXi':
      return 'missing_xi';
    case 'passChain':
      return 'pass_chain';
    case 'statSniper':
      return 'stat_sniper';
    case 'fifaCards':
    case 'cardDetective':
      // Cards live in fifa_cards, not in the questions pool.
      return null;
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
  missingXi: 30, // per shirt named: 3 squads × 11 shirts → 990 coins for a perfect day
  passChain: 150, // per puzzle solved: 2 puzzles → 300 coins for a perfect day
  statSniper: 3, // score = accuracy 0–100 → 300 coins for a perfect day
  fifaCards: 1, // 10 points per solved card → at most 100 coins/day
  cardDetective: 0.1, // coins left per solved card (≤1,000/day) → at most 100 coins/day
};

const MONEY_DROP_COIN_CAP = 1500;

/**
 * Per-round ceilings for the two types whose score is bounded by payload
 * content rather than settings (countdown counts every answer found across a
 * round's answer groups; highLow counts every correct matchup). Payloads have
 * no schema maximum, so these are deliberately generous gameplay ceilings —
 * their job is to stop minted scores, not to referee a perfect round.
 */
const COUNTDOWN_MAX_ANSWERS_PER_ROUND = 25;
// The daily Countdown client plays exactly two rounds regardless of config
// (CountdownGame.tsx slices to 2), so extra configured rounds can't score.
const COUNTDOWN_PLAYED_ROUNDS = 2;
const CLUES_MAX_POINTS_PER_QUESTION = 100;
const PUT_IN_ORDER_POINTS_PER_ROUND = 100;

/**
 * Highest score a legitimate round of this type can produce, derived from the
 * challenge's settings. Settings that don't parse fail closed: a session could
 * never have been issued from them (getChallengeSession parses strictly), so a
 * completion against them is not a real round.
 */
export function getMaxScoreForCompletion(challengeType: DailyChallengeType, settings: unknown): number {
  const schema = dailyChallengeSettingsSchemas[challengeType];
  const parsed = schema.safeParse(settings);
  if (!parsed.success) {
    throw new ValidationError('Invalid daily challenge settings', parsed.error.flatten());
  }
  const s = parsed.data as unknown as { questionCount?: number; roundCount?: number; startingMoney?: number; cardCount?: number; squadCount?: number; puzzleCount?: number };
  const questionCount = s.questionCount ?? 20;
  const roundCount = s.roundCount ?? 10;

  switch (challengeType) {
    case 'moneyDrop':
      return s.startingMoney ?? 100000;
    case 'trueFalse':
    case 'imposter':
    case 'careerPath':
    case 'footballLogic':
      return questionCount;
    case 'missingXi':
      return (s.squadCount ?? 3) * 11;
    case 'passChain':
      return s.puzzleCount ?? 2;
    case 'statSniper':
      // Score is the average proximity (0–100) over the round, not a sum, so a day is always out of 100.
      return 100;
    case 'clues':
      return questionCount * CLUES_MAX_POINTS_PER_QUESTION;
    case 'putInOrder':
      return roundCount * PUT_IN_ORDER_POINTS_PER_ROUND;
    case 'countdown':
      return Math.min(roundCount, COUNTDOWN_PLAYED_ROUNDS) * COUNTDOWN_MAX_ANSWERS_PER_ROUND;
    case 'highLow':
      // One point per round cleared (HighLowGame.resolveRound), not per matchup.
      return roundCount;
    case 'fifaCards':
      return (s.cardCount ?? 10) * FIFA_CARDS_POINTS_PER_SOLVE;
    case 'cardDetective':
      return (s.cardCount ?? 10) * CARD_DETECTIVE_START_COINS;
  }
}

function clampScoreForCompletion(challengeType: DailyChallengeType, score: number, settings: unknown): number {
  const normalizedScore = Math.max(0, Math.floor(score));
  return Math.min(normalizedScore, getMaxScoreForCompletion(challengeType, settings));
}

function getCoinsAwardedForCompletion(challengeType: DailyChallengeType, score: number): number {
  const normalizedScore = Math.max(0, Math.floor(score));

  if (challengeType === 'moneyDrop') {
    return Math.min(normalizedScore, MONEY_DROP_COIN_CAP);
  }

  // Fractional rates (Card Detective) must never mint fractional coins.
  return Math.floor(normalizedScore * COINS_PER_SCORE_POINT[challengeType]);
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

// --- Pass Chain helpers -------------------------------------------------------
type PassChainClub = { key: string; kind?: 'club' | 'manager'; en: string; ka?: string; es?: string };
const PASS_CHAIN_UNIVERSE_TTL_MS = 10 * 60 * 1000;
let passChainUniverseCache: { loadedAt: number; players: PassChainPlayerRow[]; byId: Map<string, PassChainPlayerRow>; byTm: Map<number, PassChainPlayerRow> } | null = null;

async function loadPassChainUniverse() {
  if (passChainUniverseCache && Date.now() - passChainUniverseCache.loadedAt < PASS_CHAIN_UNIVERSE_TTL_MS) return passChainUniverseCache;
  const players = await dailyChallengesRepo.listAllPassChainPlayers();
  passChainUniverseCache = {
    loadedAt: Date.now(),
    players,
    byId: new Map(players.map((p) => [p.id, p])),
    byTm: new Map(players.map((p) => [p.tm_id, p])),
  };
  return passChainUniverseCache;
}

function passChainClubs(row: PassChainPlayerRow): PassChainClub[] {
  return Array.isArray(row.clubs) ? (row.clubs as unknown as PassChainClub[]) : [];
}

function passChainLinks(row: PassChainPlayerRow): PassChainClub[] {
  const managers = Array.isArray(row.managers) ? (row.managers as unknown as PassChainClub[]) : [];
  return [...passChainClubs(row).map((c) => ({ ...c, kind: 'club' as const })), ...managers.map((m) => ({ ...m, kind: 'manager' as const }))];
}

/** Shared club first, shared coach otherwise. */
function sharedClub(a: PassChainPlayerRow, b: PassChainPlayerRow): PassChainClub | null {
  const keys = new Set(passChainLinks(b).map((link) => link.key));
  return passChainLinks(a).find((link) => keys.has(link.key)) ?? null;
}

function toPassChainSessionPlayer(row: PassChainPlayerRow, locale?: string) {
  return {
    id: row.id,
    name: getLocalizedText(row.name, 'Player', locale),
    clubs: passChainClubs(row).map((club) => getLocalizedText(club as unknown as Json, club.en, locale)),
    imageUrl: row.image_url,
  };
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Same tolerance as the web answer matcher: exact alias, then a whole-word surname, then 1–2 typos on names ≥ 5 chars. */
function resolvePassChainPlayer(players: PassChainPlayerRow[], text: string): PassChainPlayerRow | null {
  const input = normalizeAnswerString(text);
  if (!input || input.length < 3) return null;
  // Ambiguity at any tier (two players share the alias or tie on distance) is "unknown": never guess a name.
  const exact = players.filter((p) => p.normalized_aliases.includes(input));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const wholeWord = players.filter((p) => p.normalized_aliases.some((alias) => alias === input || alias.startsWith(`${input} `) || alias.endsWith(` ${input}`) || alias.includes(` ${input} `)));
  if (wholeWord.length === 1) return wholeWord[0];
  if (wholeWord.length > 1 || input.length < 4) return null;
  const allowed = (target: string) => (target.length < 5 ? 0 : target.length > 6 ? 2 : 1);
  let best: { row: PassChainPlayerRow; distance: number; tied: boolean } | null = null;
  for (const p of players) {
    for (const alias of p.normalized_aliases) {
      const max = allowed(alias);
      if (max === 0 || Math.abs(alias.length - input.length) > max) continue;
      const distance = levenshtein(input, alias);
      if (distance > max) continue;
      if (!best || distance < best.distance) best = { row: p, distance, tied: false };
      else if (distance === best.distance && best.row.id !== p.id) best.tied = true;
    }
  }
  return best && !best.tied ? best.row : null;
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
  const questionType = getQuestionTypeForChallenge(challengeType);
  if (!questionType) return [];
  const rows = await dailyChallengesRepo.listAvailableCategoriesByQuestionType(questionType);
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

  /**
   * "Up next" for the completion screen: rank the challenges this player can
   * still start today by what other players are finishing (trending), what
   * they themselves play least (freshness) and what resembles the one they
   * just finished (tags), with a diversity rule across the picks.
   */
  async listRecommendations(userId: string, justPlayed?: string, limit = 2, locale?: string) {
    const day = getDailyChallengeDay();
    // 14 days is long enough to see a habit, short enough to stay current.
    const since = new Date(Date.parse(`${day}T00:00:00Z`) - 13 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const [configs, completions, playersToday, userPlays] = await Promise.all([
      dailyChallengesRepo.listConfigs(true),
      dailyChallengesRepo.listCompletionsForUserOnDay(userId, day),
      dailyChallengesRepo.countCompletionsByTypeOnDay(day),
      dailyChallengesRepo.countCompletionsForUserSince(userId, since),
    ]);
    const doneToday = new Set(completions.map((row) => row.challenge_type));
    const candidates = configs
      .filter(isKnownDailyChallengeConfig)
      .map((row) => row.challenge_type)
      .filter((type) => !doneToday.has(type) && type !== justPlayed);

    const ranked = rankDailyChallenges({
      candidates,
      playersToday: new Map(playersToday.map((row) => [row.challenge_type, row.players])),
      playsByUser: new Map(userPlays.map((row) => [row.challenge_type, row.plays])),
      justPlayed: (justPlayed ?? null) as never,
    }, limit);

    const configByType = new Map(configs.map((row) => [row.challenge_type, row]));
    return ranked
      .map((item) => {
        const config = configByType.get(item.challengeType);
        if (!config) return null;
        return { ...toListItem(config, undefined, locale), reason: item.reason };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
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

  /** Validate one typed link of a Pass Chain: resolve the name inside the player universe, check the
   *  shared club with the chain's current end, and report whether the target is now reachable. */
  async linkPassChain(userId: string, body: { puzzleId: string; fromPlayerId: string; text: string }, locale?: string) {
    const question = await dailyChallengesRepo.getQuestionPayload(body.puzzleId);
    if (!question || question.type !== 'pass_chain') throw new NotFoundError('Puzzle not found');
    const payload = questionPayloadSchema.parse(question.payload);
    if (payload.type !== 'pass_chain') throw new NotFoundError('Puzzle not found');
    const universe = await loadPassChainUniverse();
    const from = universe.byId.get(body.fromPlayerId);
    const target = universe.byTm.get(payload.target_tm_id);
    if (!from || !target) throw new NotFoundError('Puzzle not found');
    logger.debug({ userId, puzzleId: body.puzzleId }, 'pass chain link attempt');

    const candidate = resolvePassChainPlayer(universe.players, body.text);
    const none = { player: null, viaClub: null, viaKind: null, reachesTarget: false, targetClub: null, targetKind: null };
    if (!candidate) return { status: 'unknown' as const, ...none };
    const via = sharedClub(from, candidate);
    // The name resolved but shares nothing with the chain's end: say so with the player, not "unknown".
    if (!via || candidate.id === from.id) return { status: 'noLink' as const, ...none, player: toPassChainSessionPlayer(candidate, locale) };
    const toTarget = candidate.id === target.id ? via : sharedClub(candidate, target);
    return {
      status: 'linked' as const,
      player: toPassChainSessionPlayer(candidate, locale),
      viaClub: getLocalizedText(via as Json, 'Club', locale),
      viaKind: via.kind ?? 'club',
      reachesTarget: Boolean(toTarget),
      targetClub: toTarget ? getLocalizedText(toTarget as Json, 'Club', locale) : null,
      targetKind: toTarget ? toTarget.kind ?? 'club' : null,
    };
  },

  /** Today's most accurate Stat Sniper players (top N) plus the caller's own rank. */
  async getStatSniperLeaderboard(userId: string | null, limit = 10) {
    const day = getDailyChallengeDay();
    const [rows, me] = await Promise.all([
      dailyChallengesRepo.listTopCompletionsForDay('statSniper', day, limit),
      userId ? dailyChallengesRepo.getCompletionRankForDay(userId, 'statSniper', day) : Promise.resolve(null),
    ]);
    return {
      challengeDay: day,
      entries: rows.map((row, index) => ({
        userId: row.user_id,
        rank: index + 1,
        username: row.nickname,
        avatarCustomization: row.avatar_customization,
        country: row.country,
        score: row.score,
      })),
      me,
    };
  },

  /**
   * Today's set for a player. Guests (public game pages) get the same selection
   * rules and real content but no completion gate and no served-history: they
   * have no users row, and their play must not consume a member's history.
   */
  async getChallengeSession(userId: string, challengeType: DailyChallengeType, locale?: string, options: { guest?: boolean } = {}) {
    const day = getDailyChallengeDay();
    const config = await dailyChallengesRepo.getConfig(challengeType);
    if (!config || !config.is_active) {
      throw new NotFoundError('Daily challenge not available');
    }

    if (!options.guest) {
      const completion = await dailyChallengesRepo.getCompletionForUserOnDay(userId, challengeType, day);
      if (completion) {
        throwAlreadyCompleted(challengeType);
      }
    }

    const recentlyServed = options.guest ? { ids: new Set<string>(), answerKeys: new Set<string>() } : await loadRecentlyServed(userId);
    const markQuestionsServed = options.guest
      ? async () => undefined
      : (id: string, served: Array<{ id: string; answerKeys: string[] }>) => markQuestionsServedForUser(id, served);

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
          const clubMatchNames = payload.clubs.map((club) => getLocalizedText(club as Json, 'Club', 'en'));
          return {
            id: row.id,
            category: getQuestionCategory(row, locale),
            difficulty: row.difficulty,
            prompt: getQuestionPromptOrFallback(row, clubs.join(' ➔ '), locale),
            clubs,
            clubMatchNames,
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

    if (challengeType === 'cardDetective') {
      const settings = cardDetectiveSettingsSchema.parse(config.settings);
      const cards = await getOrCreateDailyCardSet(day, settings.cardCount, challengeType);

      return {
        challengeType,
        title: getDefinitionTitle(challengeType, locale),
        description: getDefinitionDescription(challengeType, locale),
        cardCount: cards.length,
        startCoins: CARD_DETECTIVE_START_COINS,
        clueCosts: { ...CARD_DETECTIVE_CLUE_COSTS },
        wrongGuessCost: CARD_DETECTIVE_WRONG_GUESS_COST,
        cards: cards.map((card) => toFifaSessionCard(card, locale)),
      };
    }

    if (challengeType === 'fifaCards') {
      const settings = fifaCardsSettingsSchema.parse(config.settings);
      const cards = await getOrCreateDailyCardSet(day, settings.cardCount, challengeType);

      return {
        challengeType,
        title: getDefinitionTitle(challengeType, locale),
        description: getDefinitionDescription(challengeType, locale),
        cardCount: cards.length,
        pointsPerSolve: FIFA_CARDS_POINTS_PER_SOLVE,
        cards: cards.map((card) => toFifaSessionCard(card, locale)),
      };
    }

    if (challengeType === 'missingXi') {
      const settings = missingXiSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);
      const validRows = (await listTypedQuestionRows(settings.categoryIds, 'missing_xi', { limit: settings.squadCount * 40 }))
        // Only line-ups confirmed by a second source (UEFA / Wikipedia) reach players.
        .filter(({ payload }) => Boolean(payload.verified));
      const selected = pickChallengeQuestions(
        ensureEnough(validRows, settings.squadCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.squadCount,
        {
          idOf: ({ row }) => row.id,
          recentlyServedIds: recentlyServed.ids,
          recentlyServedAnswerKeys: recentlyServed.answerKeys,
          answerKeysOf: ({ payload }) => answerKeysOf(payload.team as Json),
          // Two famous squads and one harder one per day; soft, like Football Logic.
          difficultyQuota: { easy: Math.max(1, settings.squadCount - 1), medium: 1, hard: 0 },
          difficultyOf: ({ row }) => row.difficulty,
        }
      );
      await markQuestionsServed(userId, servedEntriesOf(selected, ({ payload }) => answerKeysOf(payload.team as Json)));
      const faceUrls = await dailyChallengesRepo.listPlayerImagesByTransfermarktIds(
        Array.from(new Set(
          selected.flatMap(({ payload }) => payload.slots.map((slot) => slot.tm_id))
            .filter((id): id is number => typeof id === 'number')
            .map(String)
        ))
      );

      return {
        challengeType,
        title: getDefinitionTitle(challengeType, locale),
        description: getDefinitionDescription(challengeType, locale),
        squadCount: settings.squadCount,
        secondsPerSquad: settings.secondsPerSquad,
        squads: selected.map(({ row, payload }) => ({
          id: row.id,
          difficulty: row.difficulty,
          team: getLocalizedText(payload.team as Json, 'Team', locale),
          opponent: getLocalizedText(payload.opponent as Json, 'Opponent', locale),
          matchLabel: getLocalizedText(payload.match_label as Json, 'Match', locale),
          score: payload.score ?? null,
          formation: payload.formation,
          slots: payload.slots.map((slot) => ({
            id: slot.id,
            position: slot.position,
            number: slot.number ?? null,
            x: slot.x,
            y: slot.y,
            name: getLocalizedText(slot.name as Json, 'Player', locale),
            acceptedAnswers: mergeLocalizedAcceptedAnswers(slot.accepted_answers, slot.name as Json),
            imageUrl: (typeof slot.tm_id === 'number' && faceUrls.get(String(slot.tm_id))) || null,
          })),
        })),
      };
    }

    if (challengeType === 'passChain') {
      const settings = passChainSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);
      const validRows = await listTypedQuestionRows(settings.categoryIds, 'pass_chain', { limit: settings.puzzleCount * 20 });
      const selected = pickChallengeQuestions(
        ensureEnough(validRows, settings.puzzleCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.puzzleCount,
        {
          idOf: ({ row }) => row.id,
          recentlyServedIds: recentlyServed.ids,
          recentlyServedAnswerKeys: recentlyServed.answerKeys,
          answerKeysOf: ({ payload }) => [String(payload.start_tm_id), String(payload.target_tm_id)],
          // one warm-up chain and one that needs a less obvious bridge
          difficultyQuota: { easy: 1, medium: Math.max(0, settings.puzzleCount - 1), hard: 0 },
          difficultyOf: ({ row }) => row.difficulty,
        }
      );
      await markQuestionsServed(userId, servedEntriesOf(selected, ({ payload }) => [String(payload.start_tm_id), String(payload.target_tm_id)]));
      const tmIds = Array.from(new Set(selected.flatMap(({ payload }) => [payload.start_tm_id, payload.target_tm_id, ...payload.solution.map((step) => step.tm_id)])));
      const players = new Map((await dailyChallengesRepo.listPassChainPlayersByTmIds(tmIds)).map((row) => [row.tm_id, row]));
      const playerOf = (tmId: number) => {
        const row = players.get(tmId);
        if (!row) throw new DailyChallengeContentUnavailableError({ challengeType, categoryIds: settings.categoryIds });
        return toPassChainSessionPlayer(row, locale);
      };

      return {
        challengeType,
        title: getDefinitionTitle(challengeType, locale),
        description: getDefinitionDescription(challengeType, locale),
        puzzleCount: settings.puzzleCount,
        secondsPerPuzzle: settings.secondsPerPuzzle,
        puzzles: selected.map(({ row, payload }) => ({
          id: row.id,
          difficulty: row.difficulty,
          par: payload.par,
          start: playerOf(payload.start_tm_id),
          target: playerOf(payload.target_tm_id),
          solution: payload.solution.map((step) => ({ player: playerOf(step.tm_id), via: getLocalizedText(step.via as Json, 'Club', locale), kind: step.kind })),
        })),
      };
    }

    if (challengeType === 'statSniper') {
      const settings = statSniperSettingsSchema.parse(config.settings);
      await ensureActiveCategories(config.challenge_type, settings.categoryIds);
      // The whole pool, day-seeded: the leaderboard compares identical papers and a restart cannot reroll.
      const validRows = await listTypedQuestionRows(settings.categoryIds, 'stat_sniper', { limit: 5000 });
      const selected = pickDaySeeded(
        ensureEnough(validRows, settings.questionCount, challengeType, { categoryIds: settings.categoryIds }),
        settings.questionCount,
        // Guests get their own paper: the members' day-seeded set must not be readable without an account.
        options.guest ? `${getDailyChallengeDay()}:guest` : getDailyChallengeDay(),
        ({ row }) => row.id,
        ({ row }) => row.difficulty,
        footballLogicDifficultyQuota(settings.questionCount),
      );

      return {
        challengeType,
        title: getDefinitionTitle(challengeType, locale),
        description: getDefinitionDescription(challengeType, locale),
        questionCount: settings.questionCount,
        secondsPerQuestion: settings.secondsPerQuestion,
        questions: selected.map(({ row, payload }) => ({
          id: row.id,
          difficulty: row.difficulty,
          kind: payload.kind,
          prompt: getLocalizedText(payload.prompt as Json, 'Stat', locale),
          unit: getLocalizedText(payload.unit as Json, '', locale),
          value: payload.value,
          min: payload.min,
          max: payload.max,
          step: payload.step,
        })),
      };
    }

    if (challengeType !== 'footballLogic') {
      throw new NotFoundError('Daily challenge not available');
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
        difficultyQuota: footballLogicDifficultyQuota(settings.questionCount),
        difficultyOf: ({ row }) => row.difficulty,
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

  /**
   * The guest set for a day/type/locale is frozen on first use and served to every
   * guest, so freely minted guest identities can only ever read one bounded set per
   * day instead of walking the question bank. Redis holds it across replicas; an
   * in-process copy covers a Redis outage.
   */
  async getGuestChallengeSession(challengeType: DailyChallengeType, locale?: string) {
    const day = getDailyChallengeDay();
    const key = guestSetKey(day, challengeType, locale);
    const local = guestSetMemo.get(key);
    if (local && local.expiresAt > Date.now()) return local.value;
    const value = await getOrLoadJson(key, secondsUntilNextUtcDay(), () => this.getChallengeSession(GUEST_ACTOR, challengeType, locale, { guest: true }));
    guestSetMemo.set(key, { value, expiresAt: Date.now() + secondsUntilNextUtcDay() * 1000 });
    return value;
  },

  /** True when the puzzle belongs to one of today's frozen guest sets (any locale); guests may only link inside those. */
  async isGuestPuzzleToday(puzzleId: string): Promise<boolean> {
    const day = getDailyChallengeDay();
    for (const locale of ['en', 'ka', 'es']) {
      const key = guestSetKey(day, 'passChain', locale);
      const cached = guestSetMemo.get(key)?.value ?? (await getOrLoadJson(key, secondsUntilNextUtcDay(), async () => null).catch(() => null));
      const puzzles = (cached as { puzzles?: Array<{ id: string }> } | null)?.puzzles ?? [];
      if (puzzles.some((p) => p.id === puzzleId)) return true;
    }
    return false;
  },

  /** A guest's result: best score of the day is kept for the results screen; nothing is awarded. */
  async completeChallengeForGuest(guestId: string, challengeType: DailyChallengeType, score: number) {
    const day = getDailyChallengeDay();
    const config = await dailyChallengesRepo.getConfig(challengeType);
    if (!config || !config.is_active) {
      throw new NotFoundError('Daily challenge not available');
    }
    const cappedScore = clampScoreForCompletion(challengeType, score, config.settings);
    const saved = await guestRepo.upsertDailyCompletion({ guestId, challengeType, challengeDay: day, score: cappedScore });
    return { status: 'completed' as const, guest: true as const, score: cappedScore, bestScore: saved.best_score, attempts: saved.attempts, coinsAwarded: 0, xpAwarded: 0 };
  },

  async completeChallenge(
    userId: string,
    challengeType: DailyChallengeType,
    score: number,
    outcomes?: DailyChallengeCardOutcomeInput[]
  ) {
    const day = getDailyChallengeDay();
    const config = await dailyChallengesRepo.getConfig(challengeType);
    if (!config || !config.is_active) {
      throw new NotFoundError('Daily challenge not available');
    }
    // The client reports its own score; card types replace it with a score
    // derived from validated outcomes. Either way the result is clamped to what
    // this challenge can legitimately produce before it turns into coins or
    // gets recorded.
    const { score: reconciledScore, outcomes: validatedOutcomes } = await reconcileCardOutcomes(
      challengeType,
      day,
      score,
      outcomes
    );
    // Card types are already bounded by the served set (one outcome per served
    // card, each worth at most its per-card maximum); clamping them against the
    // current settings would shrink a legitimate round after a config edit.
    const cappedScore = isCardSetType(challengeType)
      ? reconciledScore
      : clampScoreForCompletion(challengeType, reconciledScore, config.settings);
    const coinsAwarded = getCoinsAwardedForCompletion(challengeType, cappedScore);
    const configuredStreakBonus = comebackBonusCoins();

    return dailyChallengesRepo.runInTransaction(async (txRepo) => {
      const existing = await txRepo.getCompletionForUserOnDay(userId, challengeType, day);
      if (existing) {
        throwAlreadyCompleted(challengeType);
      }

      const completionDaysBefore = await txRepo.listDistinctCompletionDays(userId, day, 370);

      let completionId: string | null = null;
      try {
        const created = await txRepo.createCompletion({
          userId,
          challengeType,
          challengeDay: day,
          score: cappedScore,
          coinsAwarded,
          xpAwarded: config.xp_reward,
        });
        completionId = created?.id ?? null;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
          throwAlreadyCompleted(challengeType);
        }
        throw error;
      }

      if (completionId && validatedOutcomes.length > 0) {
        await txRepo.createCardOutcomes(completionId, validatedOutcomes);
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
