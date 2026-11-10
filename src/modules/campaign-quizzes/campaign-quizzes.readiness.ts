import { BadRequestError } from '../../core/errors.js';
import {
  CAMPAIGN_QUIZ_LOCALES,
  EDITION_TEXT_FIELDS,
  missingEditionCopy,
  type CampaignLocale,
  type EditionLocale,
  type EditionTextField,
} from './campaign-quizzes.editions.js';
import { questionPayloadSchema } from '../questions/questions.schemas.js';
import {
  CAMPAIGN_QUIZ_DIFFICULTY_LIMITS,
  CAMPAIGN_QUIZ_QUESTION_LIMIT,
  selectRoundQuestions,
  toPublicQuestion,
} from './campaign-quizzes.questions.js';
import type { CampaignQuizQuestionRow } from './campaign-quizzes.repo.js';
import type { CampaignQuizAboutBlock, CampaignQuizQuestionResponse } from './campaign-quizzes.schemas.js';

export const CAMPAIGN_PUBLIC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Fields a page needs in English before any language can be ready. */
const REQUIRED_ENGLISH: readonly EditionTextField[] = [
  'title', 'h1', 'lede', 'about_heading', 'seo_title', 'meta_description', 'breadcrumb_label',
  'hero_image_alt', 'score_cta', 'footer_banner_text', 'footer_button_label',
];
const PLACEHOLDERS = ['{score}', '{count}'] as const;

export type ReadinessPage = Partial<Record<EditionTextField, string | null>>
  & { about_blocks?: CampaignQuizAboutBlock[] | null; hero_image_url?: string | null; locale_mode: 'en_only' | 'en_ka' }
  & Partial<Record<`${EditionLocale}_${EditionTextField}`, string | null>>
  & Partial<Record<`${EditionLocale}_about_blocks`, CampaignQuizAboutBlock[] | null>>;

export interface LocaleReadiness {
  locale: CampaignLocale;
  ready: boolean;
  problems: string[];
}

const filled = (value: string | null | undefined): value is string => Boolean(value?.trim());

function localeText(page: ReadinessPage, locale: CampaignLocale, field: EditionTextField): string | null | undefined {
  return locale === 'en' ? page[field] : page[`${locale}_${field}`];
}

function localeBlocks(page: ReadinessPage, locale: CampaignLocale): CampaignQuizAboutBlock[] {
  const blocks = locale === 'en' ? page.about_blocks : page[`${locale}_about_blocks`];
  return Array.isArray(blocks) ? blocks : [];
}

function copyProblems(page: ReadinessPage, locale: CampaignLocale): string[] {
  const problems: string[] = [];
  if (locale === 'en') {
    for (const field of REQUIRED_ENGLISH) if (!filled(page[field])) problems.push(`copy: ${field} is empty`);
    if (localeBlocks(page, 'en').length === 0) problems.push('copy: about_blocks is empty');
    if (!page.hero_image_url) problems.push('copy: hero image is missing');
    if (!page.score_cta?.includes('{score}')) problems.push('copy: score_cta must contain {score}');
  } else {
    for (const field of missingEditionCopy(page as Parameters<typeof missingEditionCopy>[0], locale)) {
      problems.push(`copy: ${field} is not translated`);
    }
  }
  if (locale === 'en') return problems;
  for (const field of EDITION_TEXT_FIELDS) {
    const english = page[field] ?? '';
    const translated = localeText(page, locale, field) ?? '';
    for (const placeholder of PLACEHOLDERS) {
      if (english.includes(placeholder) && filled(translated) && !translated.includes(placeholder)) {
        problems.push(`copy: ${field} lost ${placeholder}`);
      }
    }
  }
  const englishBlocks = localeBlocks(page, 'en');
  const translatedBlocks = localeBlocks(page, locale);
  englishBlocks.forEach((block, index) => {
    const translated = translatedBlocks[index];
    if (translated && (translated.id !== block?.id || translated.type !== block?.type)) {
      problems.push(`copy: about block ${index + 1} does not match the English block`);
    }
    for (const placeholder of PLACEHOLDERS) {
      if (block?.text?.includes(placeholder) && translated && !translated.text?.includes(placeholder)) {
        problems.push(`copy: about block ${index + 1} lost ${placeholder}`);
      }
    }
  });
  return problems;
}

const parsedJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/** Every text of a question as the page serves it: prompt, explanation and the parsed payload (legacy strings become {en}). */
function questionTexts(row: CampaignQuizQuestionRow): unknown[] {
  const payload = questionPayloadSchema.safeParse(parsedJson(row.payload));
  return [parsedJson(row.prompt), parsedJson(row.explanation), payload.success ? payload.data : row.payload];
}

/** A translation map: language codes to strings (the payload parser drops empty ones, so English may be gone). */
const isTextMap = (map: Record<string, unknown>): boolean => {
  const entries = Object.entries(map);
  return entries.length > 0
    && entries.every(([key, value]) => /^[a-z]{2}$/.test(key) && (value === null || typeof value === 'string'))
    && entries.some(([, value]) => typeof value === 'string');
};

/**
 * How many texts lack `locale`. A text is a translation map; a bare string reads in English only. Explanations may be absent, nothing else may be.
 */
function untranslatedTexts(row: CampaignQuizQuestionRow, locale: CampaignLocale): number {
  let missing = 0;
  const visit = (node: unknown, bareCounts: boolean) => {
    if (typeof node === 'string') {
      if (bareCounts && locale !== 'en') missing += 1;
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, false));
      return;
    }
    const map = node as Record<string, unknown>;
    if (isTextMap(map)) {
      const text = map[locale];
      if (typeof text !== 'string' || !text.trim()) missing += 1;
      return;
    }
    Object.values(map).forEach((child) => visit(child, false));
  };
  const [prompt, explanation, payload] = questionTexts(row);
  visit(prompt, true);
  if (explanation !== null && explanation !== undefined) visit(explanation, true);
  visit(payload, false);
  return missing;
}

function questionProblems(rows: CampaignQuizQuestionRow[], locale: CampaignLocale): string[] {
  const problems: string[] = [];
  const served: CampaignQuizQuestionResponse[] = [];
  for (const row of rows) {
    const missing = untranslatedTexts(row, locale);
    if (missing > 0) {
      problems.push(`question ${row.id}: ${missing} text(s) not in ${locale}`);
      continue;
    }
    try {
      served.push(toPublicQuestion(row, rows, locale));
    } catch (error) {
      if (!(error instanceof BadRequestError)) throw error;
      problems.push(`question ${row.id}: ${error.message}`);
    }
  }
  const round = selectRoundQuestions(served);
  if (round.length !== CAMPAIGN_QUIZ_QUESTION_LIMIT) {
    problems.push(`round: ${round.length} playable questions, needs ${CAMPAIGN_QUIZ_QUESTION_LIMIT}`);
  }
  for (const [difficulty, needed] of Object.entries(CAMPAIGN_QUIZ_DIFFICULTY_LIMITS)) {
    const count = round.filter((question) => question.difficulty === difficulty).length;
    if (count !== needed) problems.push(`round: ${count} ${difficulty}, needs ${needed}`);
  }
  for (const question of round) {
    if (!filled(question.prompt)) problems.push(`question ${question.id}: empty prompt`);
    const texts = question.options.map((option) => option.text.trim().toLocaleLowerCase(locale));
    if (texts.some((text) => !text)) problems.push(`question ${question.id}: empty option`);
    if (new Set(texts).size !== texts.length) problems.push(`question ${question.id}: options repeat`);
  }
  return problems;
}

/**
 * Whether the page is complete and playable in each language: copy translated with its placeholders, a public slug,
 * and the full 4/3/3 round of ten questions that build in that language with distinct options. The agent publishes
 * only when every language is ready; the CMS shows the same list.
 */
export function pageReadiness(
  page: ReadinessPage,
  rows: CampaignQuizQuestionRow[],
  publicSlugs: Partial<Record<CampaignLocale, string>>,
  locales: readonly CampaignLocale[] = CAMPAIGN_QUIZ_LOCALES,
): LocaleReadiness[] {
  const english = copyProblems(page, 'en');
  return locales.map((locale) => {
    const problems = [
      ...(locale === 'en' ? english : [...english.map((problem) => `en ${problem}`), ...copyProblems(page, locale)]),
      ...questionProblems(rows, locale),
    ];
    const slug = publicSlugs[locale];
    if (!slug || slug.length > 80 || !CAMPAIGN_PUBLIC_SLUG_PATTERN.test(slug)) problems.push('slug: missing or invalid');
    if (locale === 'ka' && page.locale_mode !== 'en_ka') problems.push('copy: Georgian is switched off (locale_mode)');
    return { locale, ready: problems.length === 0, problems };
  });
}
