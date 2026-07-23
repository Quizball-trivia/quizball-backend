import { createHash } from 'crypto';
import { BadRequestError, NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { questionPayloadSchema } from '../questions/questions.schemas.js';
import {
  campaignQuizzesRepo,
  type CampaignQuizQuestionRow,
} from './campaign-quizzes.repo.js';
import type {
  CampaignQuizAnswerResponse,
  CampaignQuizQuestionResponse,
  CampaignQuizRatingResponse,
  CampaignQuizResponse,
} from './campaign-quizzes.schemas.js';

function localizedText(value: unknown, locale = 'en'): string | null {
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

function parseCampaignQuestion(row: CampaignQuizQuestionRow): CampaignPayload {
  const parsed = questionPayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    throw new BadRequestError('Campaign quiz question payload is invalid');
  }
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

function generatedAnswer(payload: CampaignPayload): string | null {
  if (payload.type !== 'clue_chain' && payload.type !== 'career_path') return null;
  return localizedText(payload.display_answer);
}

function generatedOptions(
  row: CampaignQuizQuestionRow,
  rows: CampaignQuizQuestionRow[],
) {
  const payload = parseCampaignQuestion(row);
  const correctAnswer = generatedAnswer(payload);
  if (!correctAnswer) {
    throw new BadRequestError('Campaign quiz question has no display answer');
  }

  const distractors = rows
    .filter((candidate) => candidate.id !== row.id)
    .map((candidate) => {
      try {
        return generatedAnswer(parseCampaignQuestion(candidate));
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

function toPublicQuestion(
  row: CampaignQuizQuestionRow,
  rows: CampaignQuizQuestionRow[],
): CampaignQuizQuestionResponse {
  const payload = parseCampaignQuestion(row);
  const prompt = localizedText(row.prompt);
  if (!prompt) {
    throw new BadRequestError('Campaign quiz question has no English prompt');
  }

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
        text: localizedText(option.text) ?? '',
      })),
    };
  }

  const options = generatedOptions(row, rows);
  return {
    id: row.id,
    position: row.display_order,
    difficulty: row.difficulty,
    type: payload.type,
    prompt,
    details:
      payload.type === 'clue_chain'
        ? payload.clues
            .map((clue) => localizedText(clue.content))
            .filter((clue): clue is string => Boolean(clue))
            .filter((clue) => clue !== prompt)
        : [],
    image_url: null,
    options: options.map((option) => ({
      id: option.id,
      text: option.text,
    })),
  };
}

function normalizeRating(
  rating: Awaited<ReturnType<typeof campaignQuizzesRepo.getRating>>,
): CampaignQuizRatingResponse {
  const average = rating.average === null ? null : Number(rating.average);
  return {
    average: average !== null && Number.isFinite(average) ? average : null,
    count: Number(rating.count) || 0,
  };
}

export const campaignQuizzesService = {
  async getQuiz(slug: string): Promise<CampaignQuizResponse> {
    const quiz = await campaignQuizzesRepo.getPublishedQuiz(slug);
    if (!quiz) throw new NotFoundError('Campaign quiz not found');

    const [rows, rating] = await Promise.all([
      campaignQuizzesRepo.getPublishedQuestions(slug),
      campaignQuizzesRepo.getRating(slug),
    ]);
    const questions = rows.flatMap((row) => {
      try {
        return [toPublicQuestion(row, rows)];
      } catch (error) {
        if (!(error instanceof BadRequestError)) throw error;
        logger.warn(
          {
            quizSlug: slug,
            questionId: row.id,
            errorMessage: error.message,
          },
          'Skipping invalid campaign quiz question',
        );
        return [];
      }
    });

    return {
      slug: quiz.slug,
      title: quiz.title,
      total_questions: questions.length,
      questions,
      rating: normalizeRating(rating),
    };
  },

  async answer(
    slug: string,
    questionId: string,
    selectedOptionId: string,
  ): Promise<CampaignQuizAnswerResponse> {
    const rows = await campaignQuizzesRepo.getPublishedQuestions(slug);
    const row = rows.find((candidate) => candidate.id === questionId);
    if (!row) throw new NotFoundError('Campaign quiz question not found');

    const payload = parseCampaignQuestion(row);
    const options =
      payload.type === 'mcq_single' || payload.type === 'true_false'
        ? payload.options.map((option) => ({
            id: option.id,
            isCorrect: option.is_correct,
          }))
        : generatedOptions(row, rows);
    const selected = options.find((option) => option.id === selectedOptionId);
    if (!selected) {
      throw new BadRequestError('Selected option is not valid for this question');
    }

    const correct = options.find((option) => option.isCorrect);
    if (!correct) throw new BadRequestError('Campaign quiz question has no correct option');

    const generated = generatedAnswer(payload);

    return {
      correct: selected.isCorrect,
      correct_option_id: correct.id,
      explanation:
        localizedText(row.explanation)
        ?? (generated ? `Correct answer: ${generated}.` : null),
    };
  },

  async rate(slug: string, userId: string, rating: number): Promise<CampaignQuizRatingResponse> {
    const quiz = await campaignQuizzesRepo.getPublishedQuiz(slug);
    if (!quiz) throw new NotFoundError('Campaign quiz not found');

    await campaignQuizzesRepo.upsertRating(slug, userId, rating);
    return normalizeRating(await campaignQuizzesRepo.getRating(slug));
  },
};
