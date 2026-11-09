import { createHash } from 'node:crypto';
import { BadRequestError } from '../../core/errors.js';
import { questionPayloadSchema } from '../questions/questions.schemas.js';
import { CAMPAIGN_QUIZ_LOCALES, FULL_COPY_LOCALES, type CampaignLocale, type EditionLocale } from './campaign-quizzes.editions.js';
import type { CampaignQuizQuestionRow } from './campaign-quizzes.repo.js';
import type { CampaignQuizQuestionResponse } from './campaign-quizzes.schemas.js';

export function localizedText(value: unknown, locale = 'en'): string | null {
  if (typeof value === 'string') {
    try {
      return localizedText(JSON.parse(value), locale);
    } catch {
      return value.trim() || null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const field = value as Record<string, unknown>;
  const preferred = field[locale];
  if (typeof preferred === 'string' && preferred.trim()) return preferred.trim();
  const english = field.en;
  if (typeof english === 'string' && english.trim()) return english.trim();
  const fallback = Object.values(field).find(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
  return fallback?.trim() ?? null;
}

type ParsedQuestionPayload = ReturnType<typeof questionPayloadSchema.parse>;
type CampaignPayload = Extract<
  ParsedQuestionPayload,
  { type: 'mcq_single' | 'true_false' | 'clue_chain' | 'career_path' }
>;

export function parseCampaignQuestion(row: CampaignQuizQuestionRow): CampaignPayload {
  const parsed = questionPayloadSchema.safeParse(row.payload);
  if (!parsed.success) throw new BadRequestError('Campaign quiz question payload is invalid');
  const payload = parsed.data;
  if (
    payload.type !== 'mcq_single'
    && payload.type !== 'true_false'
    && payload.type !== 'clue_chain'
    && payload.type !== 'career_path'
  ) {
    throw new BadRequestError('Campaign quiz question type is not supported');
  }
  return payload as CampaignPayload;
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function generatedAnswer(payload: CampaignPayload, locale: CampaignLocale = 'en'): string | null {
  if (payload.type !== 'clue_chain' && payload.type !== 'career_path') return null;
  return localizedText(payload.display_answer, locale);
}

export function generatedOptions(
  row: CampaignQuizQuestionRow,
  rows: CampaignQuizQuestionRow[],
  locale: CampaignLocale = 'en',
) {
  const payload = parseCampaignQuestion(row);
  const correctAnswer = generatedAnswer(payload, locale);
  if (!correctAnswer) throw new BadRequestError('Campaign quiz question has no display answer');

  const distractors = rows
    .filter((candidate) => candidate.id !== row.id)
    .map((candidate) => {
      try {
        return generatedAnswer(parseCampaignQuestion(candidate), locale);
      } catch (error) {
        if (error instanceof BadRequestError) return null;
        throw error;
      }
    })
    .filter((answer): answer is string => Boolean(answer && answer !== correctAnswer))
    .filter((answer, index, answers) => answers.indexOf(answer) === index)
    .sort((left, right) =>
      stableHash(`${row.id}:distractor:${left}`)
        .localeCompare(stableHash(`${row.id}:distractor:${right}`)),
    )
    .slice(0, 3);

  if (distractors.length < 3) {
    throw new BadRequestError('Campaign quiz question needs three answer distractors');
  }

  return [correctAnswer, ...distractors]
    .sort((left, right) =>
      stableHash(`${row.id}:option:${left}`)
        .localeCompare(stableHash(`${row.id}:option:${right}`)),
    )
    .map((text, index) => ({
      id: String.fromCharCode(97 + index),
      text,
      isCorrect: text === correctAnswer,
    }));
}

export function toPublicQuestion(
  row: CampaignQuizQuestionRow,
  rows: CampaignQuizQuestionRow[],
  locale: CampaignLocale = 'en',
): CampaignQuizQuestionResponse {
  const payload = parseCampaignQuestion(row);
  const prompt = localizedText(row.prompt, locale);
  if (!prompt) throw new BadRequestError(`Campaign quiz question has no ${locale} prompt`);

  if (payload.type === 'mcq_single' || payload.type === 'true_false') {
    return {
      id: row.id,
      position: row.display_order,
      difficulty: row.difficulty,
      type: payload.type,
      prompt,
      details: [],
      image_url: payload.type === 'mcq_single' ? payload.image?.url ?? null : null,
      options: payload.options.map((option) => ({
        id: option.id,
        text: localizedText(option.text, locale) ?? '',
      })),
    };
  }

  const options = generatedOptions(row, rows, locale);
  return {
    id: row.id,
    position: row.display_order,
    difficulty: row.difficulty,
    type: payload.type,
    prompt,
    details:
      payload.type === 'clue_chain'
        ? payload.clues
            .map((clue) => localizedText(clue.content, locale))
            .filter((clue): clue is string => Boolean(clue))
            .filter((clue) => clue !== prompt)
        : payload.clubs
            .map((club) => localizedText(club, locale))
            .filter((club): club is string => Boolean(club)),
    image_url: null,
    options: options.map((option) => ({ id: option.id, text: option.text })),
  };
}

/** A translations map ({en, es, …}), with or without English: every value a string, at least one a locale key. */
const isTextMap = (node: Record<string, unknown>): boolean =>
  CAMPAIGN_QUIZ_LOCALES.some((key) => typeof node[key] === 'string') && Object.values(node).every((entry) => typeof entry === 'string');

/** Every translations map under a JSON value: prompts, options, clues, display answers, explanations. */
function localizedNodes(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (typeof value === 'string') {
    try {
      return localizedNodes(JSON.parse(value), out);
    } catch {
      return out;
    }
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => localizedNodes(entry, out));
  } else if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (isTextMap(node)) out.push(node);
    else Object.values(node).forEach((entry) => localizedNodes(entry, out));
  }
  return out;
}

const hasLocale = (node: Record<string, unknown>, locale: CampaignLocale): boolean =>
  typeof node[locale] === 'string' && (node[locale] as string).trim().length > 0;

/** A plain string in a text column, which the page serves as is: English only. */
function isBareText(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return !parsed || typeof parsed !== 'object';
  } catch {
    return true;
  }
}

/** The payload as the page reads it: the parser turns legacy string options into English text maps. */
function servedPayload(row: CampaignQuizQuestionRow): unknown {
  const parsed = questionPayloadSchema.safeParse(row.payload);
  return parsed.success ? parsed.data : row.payload;
}

/** ka and tr count what the page really serves in English; the older editions keep their rule, so their open pages stay open. */
const isStrict = (locale: CampaignLocale) => FULL_COPY_LOCALES.includes(locale as EditionLocale);

/** How many texts of a question have no `locale` slot (what still has to be translated before the edition opens). */
export function missingLocaleSlots(row: CampaignQuizQuestionRow, locale: CampaignLocale): number {
  const strict = isStrict(locale);
  const unfilled = [row.prompt, strict ? servedPayload(row) : row.payload, row.explanation]
    .flatMap((value) => localizedNodes(value))
    .filter((node) => !hasLocale(node, locale)).length;
  return unfilled + (strict && isBareText(row.explanation) ? 1 : 0);
}

/** The reason a question keeps an edition off, or null when it reads fully in `locale`. */
export function questionLocaleProblem(
  row: CampaignQuizQuestionRow,
  rows: CampaignQuizQuestionRow[],
  locale: CampaignLocale,
): 'missing_texts' | 'bare_prompt' | 'does_not_build' | null {
  try {
    toPublicQuestion(row, rows, 'en');
  } catch (error) {
    if (error instanceof BadRequestError) return null;
    throw error;
  }
  if (localizedNodes(row.prompt).length === 0) return 'bare_prompt';
  if (missingLocaleSlots(row, locale) > 0) return 'missing_texts';
  // Generated answers can collapse in translation (two English names, one translated form): the question must still build.
  try {
    toPublicQuestion(row, rows, locale);
    return null;
  } catch (error) {
    if (error instanceof BadRequestError) return 'does_not_build';
    throw error;
  }
}

/**
 * True when every servable question of a set reads fully in `locale`. A text without that key would be served in
 * English (localizedText falls back), so one such text keeps the whole edition off, as does a question that builds in
 * English but not in `locale`. A question the page skips as invalid in English is not counted. A bare string prompt (no
 * locale keys) counts as English only. For ka and tr a set with nothing left to play has no edition either.
 */
export function questionsHaveLocale(rows: CampaignQuizQuestionRow[], locale: CampaignLocale): boolean {
  const playable = rows.some((row) => {
    try {
      toPublicQuestion(row, rows, 'en');
      return true;
    } catch (error) {
      if (error instanceof BadRequestError) return false;
      throw error;
    }
  });
  if (isStrict(locale) && !playable) return false;
  return rows.every((row) => questionLocaleProblem(row, rows, locale) === null);
}

const textMap = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      return textMap(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
};

/**
 * A CMS save carries English only. A text whose English did not change keeps its other languages; a changed text
 * drops them, since they translate the old wording (the gated editions then close until it is translated again).
 */
export function withKeptTranslations(existing: unknown, english: string): Record<string, string> {
  const current = textMap(existing);
  if (typeof current?.en !== 'string' || current.en.trim() !== english.trim()) return { en: english };
  const texts = Object.entries(current).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return { ...Object.fromEntries(texts), en: english };
}

/** The translated text of option `id` in a stored mcq payload. */
export function existingOptionText(payload: unknown, id: string): unknown {
  const options = (textMap(payload) as { options?: unknown } | null)?.options;
  if (!Array.isArray(options)) return null;
  return (options.find((option) => (option as { id?: unknown } | null)?.id === id) as { text?: unknown } | undefined)?.text ?? null;
}
