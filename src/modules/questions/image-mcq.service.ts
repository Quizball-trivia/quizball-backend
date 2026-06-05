import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { config } from '../../core/config.js';
import { BadRequestError, ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { getLocalizedString } from '../../lib/localization.js';
import type { Category, Json } from '../../db/types.js';
import { categoriesRepo } from '../categories/categories.repo.js';
import { questionsService } from './questions.service.js';
import { toQuestionResponse, type QuestionResponse } from './questions.schemas.js';
import { translationService } from './translation.service.js';
import { uploadQuestionImageBuffer } from './question-image-storage.service.js';
import type {
  GeneratedImageMcqCard,
  ImageMcqGeneratePreviewRequest,
  ImageMcqGeneratePreviewResponse,
  ImageMcqSaveDraftsResponse,
} from './image-mcq.schemas.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const COMMONS_API_URL = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'QuizballImageMcqGenerator/1.0';
const ALLOWED_LICENSES = ['cc0', 'public domain', 'cc by', 'cc by-sa'];
const DOWNLOAD_DELAY_MS = 900;
const REQUIRED_QUESTIONS_PER_IMAGE = 6;
const REQUIRED_DIFFICULTY_COUNT = 2;
const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
const COMMONS_MAX_RESULTS_PER_QUERY = 50;

export type ImageMcqProgressStage =
  | 'started'
  | 'category_started'
  | 'commons_search'
  | 'candidates_selected'
  | 'candidate_started'
  | 'image_normalized'
  | 'openrouter_started'
  | 'openrouter_completed'
  | 'candidate_completed'
  | 'candidate_skipped'
  | 'category_completed'
  | 'completed';

export interface ImageMcqProgressEvent {
  stage: ImageMcqProgressStage;
  message: string;
  completed_images: number;
  total_images: number;
  cards_generated: number;
  target_cards: number;
  current_category?: string;
  current_image_title?: string;
}

type ImageMcqProgressReporter = (event: ImageMcqProgressEvent) => void;

interface CandidateImage {
  categoryId: string;
  categorySlug: string;
  categoryName: string;
  imageUrl: string;
  sourceUrl: string;
  title: string;
  author: string | null;
  license: string | null;
  licenseUrl: string | null;
  provider: 'category_image_url' | 'wikimedia_commons';
}

interface NormalizedImage extends CandidateImage {
  dataUrl: string;
  png: Buffer;
  width: number;
  height: number;
  aspectRatio: string;
  hash: string;
}

interface AiQuestion {
  prompt: { en: string };
  difficulty: 'easy' | 'medium' | 'hard';
  options: Array<{
    id: 'a' | 'b' | 'c' | 'd';
    text: { en: string };
    is_correct: boolean;
  }>;
  explanation: { en: string };
  confidence: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function allowedLicense(license: string | null): boolean {
  if (!license) return true;
  const normalized = license.toLowerCase();
  if (normalized.includes('noncommercial') || normalized.includes('no derivatives')) return false;
  return ALLOWED_LICENSES.some((allowed) => normalized.includes(allowed));
}

function aspectRatio(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    const current = copy[index]!;
    copy[index] = copy[randomIndex]!;
    copy[randomIndex] = current;
  }
  return copy;
}

async function normalizeImageToTransparentPng(input: Buffer, width: number, height: number): Promise<Buffer> {
  try {
    const source = sharp(input, { failOn: 'none' }).rotate().ensureAlpha();
    const metadata = await source.metadata();
    const trimmed = metadata.hasAlpha
      ? await source
          .clone()
          .trim({
            background: { r: 0, g: 0, b: 0, alpha: 0 },
            threshold: 1,
          })
          .toBuffer()
      : await source.clone().toBuffer();

    const fitWidth = Math.round(width * 0.92);
    const fitHeight = Math.round(height * 0.92);
    const resized = await sharp(trimmed, { failOn: 'none' })
      .resize({
        width: fitWidth,
        height: fitHeight,
        fit: 'inside',
        withoutEnlargement: false,
      })
      .png()
      .toBuffer();
    const resizedMetadata = await sharp(resized).metadata();
    const resizedWidth = resizedMetadata.width ?? fitWidth;
    const resizedHeight = resizedMetadata.height ?? fitHeight;
    const left = Math.max(0, Math.floor((width - resizedWidth) / 2));
    const top = Math.max(0, Math.floor((height - resizedHeight) / 2));

    return sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: resized, left, top }])
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  } catch (error) {
    throw new BadRequestError(`Image normalization failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new ExternalServiceError(`Image search failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function queriesForCategory(category: Category): string[] {
  const name = getLocalizedString(category.name) || category.slug;
  const slug = category.slug.toLowerCase();
  const queries = [
    `${name} association football`,
    `${name} soccer`,
    `${name} football club`,
  ];

  if (slug === '00s') queries.unshift('2000s association football players');
  if (slug === '10s') queries.unshift('2010s association football players');
  if (slug === '80s') queries.unshift('1980s association football players');
  if (slug === '90s') queries.unshift('1990s association football players');
  if (slug.includes('badge') || slug.includes('logo')) queries.unshift('association football club crests');
  if (slug.includes('world-cup')) queries.unshift('FIFA World Cup trophy football');
  if (slug.includes('champio')) queries.unshift('UEFA Champions League trophy football');
  if (slug.includes('daily') || slug.includes('logic') || slug.includes('career') || slug.includes('countdown') || slug.includes('clues')) {
    queries.unshift('association football stadium', 'association football ball');
  }

  return [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
}

async function searchCommons(category: Category, limit: number): Promise<CandidateImage[]> {
  const categoryName = getLocalizedString(category.name) || category.slug;
  const candidates: CandidateImage[] = [];
  const poolLimit = Math.max(limit * 3, limit);

  type CommonsResponse = {
    query?: {
      pages?: Record<string, {
        title: string;
        imageinfo?: Array<{
          url?: string;
          descriptionurl?: string;
          mime?: string;
          extmetadata?: Record<string, { value?: string }>;
        }>;
      }>;
    };
  };

  for (const query of queriesForCategory(category)) {
    if (candidates.length >= poolLimit) break;
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      generator: 'search',
      gsrsearch: query,
      gsrnamespace: '6',
      gsrlimit: String(Math.min(COMMONS_MAX_RESULTS_PER_QUERY, Math.max(12, limit * 4))),
      prop: 'imageinfo',
      iiprop: 'url|mime|extmetadata',
      origin: '*',
    });

    const data = await fetchJson<CommonsResponse>(`${COMMONS_API_URL}?${params.toString()}`);
    const pages = Object.values(data.query?.pages ?? {});
    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info?.url || (info.mime && !info.mime.startsWith('image/'))) continue;
      if (candidates.some((candidate) => candidate.imageUrl === info.url)) continue;

      const meta = info.extmetadata ?? {};
      const license = stripHtml(meta.LicenseShortName?.value ?? meta.UsageTerms?.value ?? '') || null;
      if (!allowedLicense(license)) continue;

      candidates.push({
        categoryId: category.id,
        categorySlug: category.slug,
        categoryName,
        imageUrl: info.url,
        sourceUrl: info.descriptionurl ?? info.url,
        title: stripHtml(meta.ObjectName?.value ?? page.title.replace(/^File:/, '')),
        author: stripHtml(meta.Artist?.value ?? '') || null,
        license,
        licenseUrl: meta.LicenseUrl?.value ?? null,
        provider: 'wikimedia_commons',
      });
      if (candidates.length >= poolLimit) break;
    }
  }

  return shuffled(candidates).slice(0, limit);
}

function categoryImageCandidate(category: Category): CandidateImage | null {
  if (!category.image_url) return null;
  const categoryName = getLocalizedString(category.name) || category.slug;
  return {
    categoryId: category.id,
    categorySlug: category.slug,
    categoryName,
    imageUrl: category.image_url,
    sourceUrl: category.image_url,
    title: `${categoryName} category image`,
    author: null,
    license: null,
    licenseUrl: null,
    provider: 'category_image_url',
  };
}

async function normalizeCandidate(candidate: CandidateImage, width: number, height: number): Promise<NormalizedImage> {
  let response: Response | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await fetch(candidate.imageUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (response.ok || response.status !== 429) break;
    await sleep(DOWNLOAD_DELAY_MS * attempt);
  }

  if (!response || !response.ok) {
    throw new ExternalServiceError(`Image download failed: ${response?.status ?? 'unknown'}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) {
    throw new BadRequestError(`Not an image content-type: ${contentType}`);
  }

  const original = Buffer.from(await response.arrayBuffer());
  const png = await normalizeImageToTransparentPng(original, width, height);
  const hash = createHash('sha256').update(png).digest('hex');
  return {
    ...candidate,
    png,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width,
    height,
    aspectRatio: aspectRatio(width, height),
    hash,
  };
}

function parseAiQuestions(content: string): AiQuestion[] {
  let cleaned = content.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    logger.error({ length: cleaned.length }, 'Failed to parse image MCQ generation response');
    throw new ExternalServiceError('Invalid JSON from image question generator');
  }

  const questions = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];

  return questions.filter((question): question is AiQuestion => {
    if (!question || typeof question !== 'object') return false;
    const candidate = question as AiQuestion;
    return Boolean(
      candidate.prompt?.en
      && candidate.explanation?.en
      && ['easy', 'medium', 'hard'].includes(candidate.difficulty)
      && Array.isArray(candidate.options)
      && candidate.options.length === 4
      && candidate.options.filter((option) => option.is_correct).length === 1
    );
  });
}

function selectBalancedQuestions(questions: AiQuestion[], questionsPerImage: number): AiQuestion[] {
  if (questionsPerImage !== REQUIRED_QUESTIONS_PER_IMAGE) {
    return questions.slice(0, questionsPerImage);
  }

  const selected = DIFFICULTIES.flatMap((difficulty) =>
    questions
      .filter((question) => question.difficulty === difficulty)
      .slice(0, REQUIRED_DIFFICULTY_COUNT)
  );

  if (selected.length !== REQUIRED_QUESTIONS_PER_IMAGE) {
    throw new ExternalServiceError('Image question generator did not return 2 easy, 2 medium, and 2 hard questions');
  }

  return selected;
}

async function generateQuestionsForImage(image: NormalizedImage, questionsPerImage: number, model: string): Promise<AiQuestion[]> {
  if (!config.OPENROUTER_API_KEY) {
    throw new ExternalServiceError('OpenRouter API key not configured');
  }

  const startedAt = Date.now();
  logger.info(
    {
      categoryId: image.categoryId,
      categorySlug: image.categorySlug,
      title: image.title,
      model,
      questionsPerImage,
      imageWidth: image.width,
      imageHeight: image.height,
    },
    'Image MCQ OpenRouter request started'
  );

  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://quizball.app',
      'X-Title': 'Quizball CMS Image MCQ Generator',
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 3200,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You create accurate, non-trivial football quiz multiple-choice questions from images. Return only JSON with a "questions" array. Each question must have exactly four options and exactly one correct option. Do not invent facts that are not visible in the image or strongly supported by the provided metadata. Avoid throwaway questions such as identifying the sport, counting obvious people, naming a dominant color, or asking whether a ball is visible.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `Generate exactly ${questionsPerImage} multiple-choice questions.`,
                'Difficulty mix must be exactly: 2 easy, 2 medium, 2 hard.',
                `Category: ${image.categoryName}`,
                `Image title: ${image.title}`,
                `Source: ${image.sourceUrl}`,
                `License: ${image.license ?? 'unknown'}`,
                '',
                'Question quality rules:',
                '- Easy: answerable from a meaningful visible clue or source metadata, but not a one-word obvious object/color question.',
                '- Medium: requires combining the image with football context from the title/source/category metadata.',
                '- Hard: asks a more specific football knowledge question that is strongly supported by the image/title/source metadata.',
                '- Do not ask for exact dates, scores, hidden history, or player identity unless the metadata clearly supports it.',
                '- Make distractors plausible football answers, not random other sports.',
                '',
                'Return JSON only in this shape:',
                '{"questions":[{"prompt":{"en":"..."}, "difficulty":"easy|medium|hard", "options":[{"id":"a","text":{"en":"..."},"is_correct":false},{"id":"b","text":{"en":"..."},"is_correct":true},{"id":"c","text":{"en":"..."},"is_correct":false},{"id":"d","text":{"en":"..."},"is_correct":false}], "explanation":{"en":"..."}, "confidence":0.9}]}',
              ].join('\n'),
            },
            {
              type: 'image_url',
              image_url: { url: image.dataUrl },
            },
          ],
        },
      ],
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    logger.error(
      {
        categoryId: image.categoryId,
        categorySlug: image.categorySlug,
        title: image.title,
        status: response.status,
        bodyLength: bodyText.length,
        durationMs: Date.now() - startedAt,
      },
      'OpenRouter image MCQ generation failed'
    );
    throw new ExternalServiceError(`OpenRouter image MCQ generation failed: ${response.status}`);
  }

  const data = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? '';
  const questions = selectBalancedQuestions(parseAiQuestions(content), questionsPerImage);
  logger.info(
    {
      categoryId: image.categoryId,
      categorySlug: image.categorySlug,
      title: image.title,
      questionCount: questions.length,
      durationMs: Date.now() - startedAt,
    },
    'Image MCQ OpenRouter request completed'
  );
  return questions;
}

async function uploadImage(card: GeneratedImageMcqCard): Promise<string> {
  const base64 = card.image.data_url.replace(/^data:image\/png;base64,/, '');
  const body = Buffer.from(base64, 'base64');
  const stored = await uploadQuestionImageBuffer(body, {
    categorySlug: card.category_slug,
    width: card.image.width,
    height: card.image.height,
  });
  return stored.url;
}

async function loadCategories(request: ImageMcqGeneratePreviewRequest): Promise<Category[]> {
  if (request.category_ids?.length) {
    return categoriesRepo.listByIds(request.category_ids);
  }
  const { categories } = await categoriesRepo.list({ isActive: true }, 1, request.limit_categories);
  return categories;
}

export const imageMcqService = {
  async generatePreview(
    request: ImageMcqGeneratePreviewRequest,
    onProgress?: ImageMcqProgressReporter
  ): Promise<ImageMcqGeneratePreviewResponse> {
    const startedAt = Date.now();
    const model = request.model ?? config.OPENROUTER_MODEL;
    const categories = await loadCategories(request);
    const cards: GeneratedImageMcqCard[] = [];
    const skipped: ImageMcqGeneratePreviewResponse['skipped'] = [];
    const totalImages = categories.length * request.images_per_category;
    const targetCards = totalImages * request.questions_per_image;
    let completedImages = 0;

    const emitProgress = (
      stage: ImageMcqProgressStage,
      message: string,
      extra: Partial<Pick<ImageMcqProgressEvent, 'current_category' | 'current_image_title'>> = {}
    ) => {
      onProgress?.({
        stage,
        message,
        completed_images: completedImages,
        total_images: totalImages,
        cards_generated: cards.length,
        target_cards: targetCards,
        ...extra,
      });
    };

    logger.info(
      {
        categoryIds: categories.map((category) => category.id),
        categorySlugs: categories.map((category) => category.slug),
        imagesPerCategory: request.images_per_category,
        questionsPerImage: request.questions_per_image,
        imageWidth: request.image_width,
        imageHeight: request.image_height,
        model,
      },
      'Image MCQ preview generation started'
    );
    emitProgress('started', `Starting generation for ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}.`);

    for (const category of categories) {
      const categoryStartedAt = Date.now();
      const candidates: CandidateImage[] = [];
      const existing = categoryImageCandidate(category);
      if (existing) candidates.push(existing);
      const categoryName = getLocalizedString(category.name) || category.slug;
      emitProgress('category_started', `Preparing ${categoryName}.`, {
        current_category: categoryName,
      });

      const needed = Math.max(0, request.images_per_category - candidates.length);
      if (needed > 0) {
        emitProgress('commons_search', `Searching image sources for ${categoryName}.`, {
          current_category: categoryName,
        });
        logger.info(
          {
            categoryId: category.id,
            categorySlug: category.slug,
            needed,
          },
          'Image MCQ Commons search started'
        );
        candidates.push(...await searchCommons(category, needed));
      }

      if (candidates.length === 0) {
        completedImages += request.images_per_category;
        emitProgress('category_completed', `Skipped ${categoryName}: no usable image candidates found.`, {
          current_category: categoryName,
        });
        logger.warn(
          {
            categoryId: category.id,
            categorySlug: category.slug,
            durationMs: Date.now() - categoryStartedAt,
          },
          'Image MCQ category skipped: no image candidates found'
        );
        skipped.push({ category_id: category.id, category_slug: category.slug, reason: 'No image candidates found' });
        continue;
      }

      const selectedCandidates = candidates.slice(0, request.images_per_category);
      emitProgress('candidates_selected', `Selected ${selectedCandidates.length} image${selectedCandidates.length === 1 ? '' : 's'} for ${categoryName}.`, {
        current_category: categoryName,
      });
      logger.info(
        {
          categoryId: category.id,
          categorySlug: category.slug,
          candidateCount: selectedCandidates.length,
          providers: selectedCandidates.map((candidate) => candidate.provider),
        },
        'Image MCQ category candidates selected'
      );

      for (let index = 0; index < selectedCandidates.length; index += 1) {
        const candidate = selectedCandidates[index];
        const candidateStartedAt = Date.now();
        try {
          emitProgress(
            'candidate_started',
            `Processing image ${index + 1} of ${selectedCandidates.length}: ${candidate.title}.`,
            {
              current_category: categoryName,
              current_image_title: candidate.title,
            }
          );
          logger.info(
            {
              categoryId: category.id,
              categorySlug: category.slug,
              candidateIndex: index + 1,
              candidateCount: selectedCandidates.length,
              provider: candidate.provider,
              title: candidate.title,
            },
            'Image MCQ candidate processing started'
          );
          await sleep(DOWNLOAD_DELAY_MS);
          const image = await normalizeCandidate(candidate, request.image_width, request.image_height);
          emitProgress('image_normalized', `Normalized image: ${candidate.title}.`, {
            current_category: categoryName,
            current_image_title: candidate.title,
          });
          logger.info(
            {
              categoryId: category.id,
              categorySlug: category.slug,
              candidateIndex: index + 1,
              hash: image.hash.slice(0, 12),
              width: image.width,
              height: image.height,
              bytes: image.png.length,
              durationMs: Date.now() - candidateStartedAt,
            },
            'Image MCQ candidate image normalized'
          );
          emitProgress('openrouter_started', `Generating questions for ${candidate.title}.`, {
            current_category: categoryName,
            current_image_title: candidate.title,
          });
          const questions = await generateQuestionsForImage(image, request.questions_per_image, model);
          emitProgress('openrouter_completed', `Generated ${questions.length} questions for ${candidate.title}.`, {
            current_category: categoryName,
            current_image_title: candidate.title,
          });

          for (const question of questions) {
            cards.push({
              id: randomUUID(),
              category_id: image.categoryId,
              category_slug: image.categorySlug,
              category_name: image.categoryName,
              prompt: question.prompt,
              difficulty: question.difficulty,
              options: question.options,
              explanation: question.explanation,
              confidence: question.confidence,
              image: {
                data_url: image.dataUrl,
                width: image.width,
                height: image.height,
                aspect_ratio: image.aspectRatio,
                source_url: image.sourceUrl,
                title: image.title,
                author: image.author,
                license: image.license,
                license_url: image.licenseUrl,
                provider: image.provider,
              },
            });
          }
          completedImages += 1;
          emitProgress('candidate_completed', `Completed ${candidate.title}.`, {
            current_category: categoryName,
            current_image_title: candidate.title,
          });
          logger.info(
            {
              categoryId: category.id,
              categorySlug: category.slug,
              candidateIndex: index + 1,
              questionCount: questions.length,
              totalCards: cards.length,
              durationMs: Date.now() - candidateStartedAt,
            },
            'Image MCQ candidate completed'
          );
        } catch (error) {
          completedImages += 1;
          emitProgress('candidate_skipped', `Skipped ${candidate.title}: ${error instanceof Error ? error.message : String(error)}`, {
            current_category: categoryName,
            current_image_title: candidate.title,
          });
          logger.warn(
            {
              categoryId: category.id,
              categorySlug: category.slug,
              candidateIndex: index + 1,
              provider: candidate.provider,
              title: candidate.title,
              durationMs: Date.now() - candidateStartedAt,
              error: error instanceof Error ? error.message : String(error),
            },
            'Image MCQ candidate skipped'
          );
          skipped.push({
            category_id: category.id,
            category_slug: category.slug,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (selectedCandidates.length < request.images_per_category) {
        completedImages += request.images_per_category - selectedCandidates.length;
      }
      emitProgress('category_completed', `Completed ${categoryName}.`, {
        current_category: categoryName,
      });
      logger.info(
        {
          categoryId: category.id,
          categorySlug: category.slug,
          totalCards: cards.length,
          durationMs: Date.now() - categoryStartedAt,
        },
        'Image MCQ category completed'
      );
    }

    logger.info(
      {
        totalCards: cards.length,
        skippedCount: skipped.length,
        durationMs: Date.now() - startedAt,
      },
      'Image MCQ preview generation completed'
    );
    emitProgress('completed', `Generation complete: ${cards.length} review cards ready.`);

    return { cards, skipped };
  },

  async saveDrafts(
    cards: GeneratedImageMcqCard[],
    userId?: string,
    options: { translateToKa?: boolean } = {}
  ): Promise<ImageMcqSaveDraftsResponse> {
    const created: QuestionResponse[] = [];
    const errors: ImageMcqSaveDraftsResponse['errors'] = [];
    const createdByCategory = new Map<string, string[]>();
    const uploadedImages = new Map<string, string>();

    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      try {
        const imageCacheKey = createHash('sha256').update(card.image.data_url).digest('hex');
        let imageUrl = uploadedImages.get(imageCacheKey);
        if (!imageUrl) {
          imageUrl = await uploadImage(card);
          uploadedImages.set(imageCacheKey, imageUrl);
        }
        const question = await questionsService.create({
          categoryId: card.category_id,
          type: 'mcq_single',
          difficulty: card.difficulty,
          status: 'draft',
          prompt: card.prompt,
          explanation: card.explanation,
          createdBy: userId,
          payload: {
            type: 'mcq_single',
            image: {
              url: imageUrl,
              width: card.image.width,
              height: card.image.height,
              aspect_ratio: card.image.aspect_ratio,
              source_url: card.image.source_url,
              title: card.image.title,
              author: card.image.author,
              license: card.image.license,
              license_url: card.image.license_url,
              provider: card.image.provider,
            },
            options: card.options,
          } as Json,
        });
        const response = toQuestionResponse(question);
        created.push(response);
        if (options.translateToKa) {
          const categoryIds = createdByCategory.get(card.category_id) ?? [];
          categoryIds.push(response.id);
          createdByCategory.set(card.category_id, categoryIds);
        }
      } catch (error) {
        errors.push({
          index,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (options.translateToKa && createdByCategory.size > 0) {
      for (const [categoryId, questionIds] of createdByCategory) {
        translationService
          .translateInBackground(questionIds, categoryId)
          .catch((error) => logger.error({ error, categoryId, questionCount: questionIds.length }, 'Image MCQ background translation trigger failed'));
      }
    }

    return {
      total: cards.length,
      successful: created.length,
      failed: errors.length,
      created,
      errors,
    };
  },
};
