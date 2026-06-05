/**
 * Dry-run image question generator.
 *
 * Reads active Quizball categories, downloads football-related images locally,
 * asks OpenRouter/Gemini to generate MCQ questions for each image, and writes a
 * static HTML preview. It does NOT upload images or questions anywhere.
 *
 * Usage:
 *   npx tsx scripts/generate-image-question-preview.ts --limit-categories 5 --images-per-category 1
 *
 * Useful options:
 *   --limit-categories 10
 *   --images-per-category 2
 *   --out tmp/image-question-preview
 *   --model google/gemini-3-flash-preview
 *   --image-width 1024 --image-height 768
 *   --skip-ai
 */

import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv();

const DEFAULT_OUT_DIR = 'tmp/image-question-preview';
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-3-flash-preview';
const DEFAULT_IMAGE_WIDTH = 1024;
const DEFAULT_IMAGE_HEIGHT = 768;
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const ALLOWED_LICENSES = ['cc0', 'public domain', 'cc by', 'cc by-sa'];
const MAX_IMAGE_BYTES_FOR_DATA_URL = 4 * 1024 * 1024;
const DOWNLOAD_DELAY_MS = 1200;
const REQUIRED_QUESTIONS_PER_IMAGE = 6;
const REQUIRED_DIFFICULTY_COUNT = 2;
const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

type I18nField = Record<string, string>;

interface CategoryRow {
  id: string;
  slug: string;
  name: I18nField | string;
  description: I18nField | string | null;
  image_url: string | null;
  is_active: boolean;
}

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

interface DownloadedImage extends CandidateImage {
  localPath: string;
  localUrl: string;
  contentType: string;
  bytes: number;
  dataUrl: string | null;
  hash: string;
}

interface GeneratedQuestion {
  prompt: I18nField;
  difficulty: 'easy' | 'medium' | 'hard';
  options: Array<{
    id: 'a' | 'b' | 'c' | 'd';
    text: I18nField;
    is_correct: boolean;
  }>;
  explanation: I18nField;
  confidence: number;
}

interface PreviewItem extends DownloadedImage {
  questions: GeneratedQuestion[];
  error: string | null;
}

interface Args {
  limitCategories: number;
  imagesPerCategory: number;
  outDir: string;
  model: string;
  skipAi: boolean;
  categorySlug: string | null;
  imageWidth: number;
  imageHeight: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const getValue = (name: string): string | null => {
    const index = args.indexOf(name);
    if (index < 0) return null;
    return args[index + 1] ?? null;
  };

  return {
    limitCategories: Number(getValue('--limit-categories') ?? 10),
    imagesPerCategory: Number(getValue('--images-per-category') ?? 1),
    outDir: getValue('--out') ?? DEFAULT_OUT_DIR,
    model: getValue('--model') ?? DEFAULT_MODEL,
    skipAi: args.includes('--skip-ai'),
    categorySlug: getValue('--category-slug'),
    imageWidth: Number(getValue('--image-width') ?? DEFAULT_IMAGE_WIDTH),
    imageHeight: Number(getValue('--image-height') ?? DEFAULT_IMAGE_HEIGHT),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.replace(/^"|"$/g, '');
}

function getLocalizedText(value: I18nField | string | null | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as I18nField;
      return parsed.en || parsed.ka || Object.values(parsed)[0] || '';
    } catch {
      return value;
    }
  }
  return value.en || value.ka || Object.values(value)[0] || '';
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'image';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function allowedLicense(license: string | null): boolean {
  if (!license) return true;
  const normalized = license.toLowerCase();
  if (normalized.includes('noncommercial') || normalized.includes('no derivatives')) return false;
  return ALLOWED_LICENSES.some((allowed) => normalized.includes(allowed));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'QuizballImageQuestionPreview/1.0 (local dry-run)',
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function loadCategories(limit: number, categorySlug: string | null): Promise<CategoryRow[]> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const sql = postgres(databaseUrl, { ssl: databaseUrl.includes('localhost') ? false : 'require', max: 1 });
  try {
    const slugFilter = categorySlug ? sql`AND slug = ${categorySlug}` : sql``;
    return await sql<CategoryRow[]>`
      SELECT id, slug, name, description, image_url, is_active
      FROM categories
      WHERE is_active = true
      ${slugFilter}
      ORDER BY COALESCE(name->>'en', name->>'ka', slug) ASC
      LIMIT ${limit}
    `;
  } finally {
    await sql.end();
  }
}

function commonsQueriesForCategory(category: CategoryRow): string[] {
  const categoryName = getLocalizedText(category.name) || category.slug;
  const slug = category.slug.toLowerCase();
  const queries = [
    `${categoryName} association football`,
    `${categoryName} soccer`,
    `${categoryName} football club`,
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

async function searchCommons(category: CategoryRow, limit: number): Promise<CandidateImage[]> {
  const categoryName = getLocalizedText(category.name) || category.slug;
  const candidates: CandidateImage[] = [];

  for (const query of commonsQueriesForCategory(category)) {
    if (candidates.length >= limit) break;

  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
      gsrsearch: query,
    gsrnamespace: '6',
    gsrlimit: String(Math.max(3, limit * 4)),
    prop: 'imageinfo',
    iiprop: 'url|mime|extmetadata',
    origin: '*',
  });

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

    const data = await fetchJson<CommonsResponse>(`${COMMONS_API}?${params.toString()}`);
    const pages = Object.values(data.query?.pages ?? {});

    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info?.url) continue;
      if (info.mime && !info.mime.startsWith('image/')) continue;
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

      if (candidates.length >= limit) break;
    }
  }

  return candidates;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function categoryImageCandidate(category: CategoryRow): CandidateImage | null {
  if (!category.image_url) return null;
  const categoryName = getLocalizedText(category.name) || category.slug;
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

function normalizeImageToTransparentPng(input: Buffer, width: number, height: number): Buffer {
  const py = `
from io import BytesIO
import sys
from PIL import Image, ImageOps

target_w = ${width}
target_h = ${height}
source = sys.stdin.buffer.read()
im = Image.open(BytesIO(source))
im = ImageOps.exif_transpose(im)
im = im.convert("RGBA")
alpha_bbox = im.getchannel("A").getbbox()
if alpha_bbox:
    im = im.crop(alpha_bbox)
fit_w = round(target_w * 0.92)
fit_h = round(target_h * 0.92)
scale = min(fit_w / im.width, fit_h / im.height)
next_w = max(1, round(im.width * scale))
next_h = max(1, round(im.height * scale))
im = im.resize((next_w, next_h), Image.LANCZOS)
canvas = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
x = (target_w - im.width) // 2
y = (target_h - im.height) // 2
canvas.alpha_composite(im, (x, y))
canvas.save(sys.stdout.buffer, "PNG", optimize=True)
`;

  const result = spawnSync('python3', ['-c', py], {
    input,
    encoding: 'buffer',
    maxBuffer: Math.max(width * height * 8, 16 * 1024 * 1024),
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8') || 'unknown Pillow error';
    throw new Error(`image normalization failed: ${stderr}`);
  }

  return result.stdout;
}

async function downloadImage(
  candidate: CandidateImage,
  imageDir: string,
  imageWidth: number,
  imageHeight: number
): Promise<DownloadedImage> {
  let response: Response | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await fetch(candidate.imageUrl, {
      headers: { 'User-Agent': 'QuizballImageQuestionPreview/1.0 (local dry-run)' },
    });
    if (response.ok || response.status !== 429) break;
    await sleep(DOWNLOAD_DELAY_MS * attempt);
  }

  if (!response) {
    throw new Error('image download did not start');
  }
  if (!response.ok) {
    throw new Error(`image download failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  if (!contentType.startsWith('image/')) {
    throw new Error(`not an image content-type: ${contentType}`);
  }

  const originalBody = Buffer.from(await response.arrayBuffer());
  const body = normalizeImageToTransparentPng(originalBody, imageWidth, imageHeight);
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  const filename = `${slugify(candidate.categorySlug)}-${hash}.png`;
  const localPath = join(imageDir, filename);
  writeFileSync(localPath, body);

  return {
    ...candidate,
    localPath,
    localUrl: `images/${filename}`,
    contentType: 'image/png',
    bytes: body.length,
    dataUrl:
      body.length <= MAX_IMAGE_BYTES_FOR_DATA_URL
        ? `data:image/png;base64,${body.toString('base64')}`
        : null,
    hash,
  };
}

function fallbackQuestion(image: DownloadedImage): GeneratedQuestion {
  return {
    prompt: {
      en: `Which football category does this image best represent?`,
    },
    difficulty: 'easy',
    options: [
      { id: 'a', text: { en: image.categoryName }, is_correct: true },
      { id: 'b', text: { en: 'Basketball' }, is_correct: false },
      { id: 'c', text: { en: 'Tennis' }, is_correct: false },
      { id: 'd', text: { en: 'Formula 1' }, is_correct: false },
    ],
    explanation: {
      en: `This is a dry-run fallback question for ${image.categoryName}.`,
    },
    confidence: 0.1,
  };
}

async function generateQuestions(image: DownloadedImage, model: string): Promise<GeneratedQuestion[]> {
  const apiKey = requireEnv('OPENROUTER_API_KEY');
  const imageRef = image.dataUrl ?? image.imageUrl;

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        minItems: 6,
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['prompt', 'difficulty', 'options', 'explanation', 'confidence'],
          properties: {
            prompt: {
              type: 'object',
              additionalProperties: false,
              required: ['en'],
              properties: { en: { type: 'string' } },
            },
            difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
            options: {
              type: 'array',
              minItems: 4,
              maxItems: 4,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'text', 'is_correct'],
                properties: {
                  id: { type: 'string', enum: ['a', 'b', 'c', 'd'] },
                  text: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['en'],
                    properties: { en: { type: 'string' } },
                  },
                  is_correct: { type: 'boolean' },
                },
              },
            },
            explanation: {
              type: 'object',
              additionalProperties: false,
              required: ['en'],
              properties: { en: { type: 'string' } },
            },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
  };

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://quizball.local',
      'X-Title': 'Quizball Image Question Preview',
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 3200,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'quizball_image_questions',
          strict: true,
          schema,
        },
      },
      messages: [
        {
          role: 'system',
          content:
            'You create accurate, non-trivial football quiz questions from images. Return only valid JSON. Every question must have exactly four options and exactly one correct option. Do not invent facts that are not visible in the image or strongly implied by the provided source metadata. Avoid throwaway questions such as identifying the sport, counting obvious people, naming a dominant color, or asking whether a ball is visible.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `Category: ${image.categoryName}`,
                `Image title: ${image.title}`,
                `Source: ${image.sourceUrl}`,
                `License: ${image.license ?? 'unknown'}`,
                '',
                `Generate exactly ${REQUIRED_QUESTIONS_PER_IMAGE} multiple-choice questions about this football image.`,
                'Difficulty mix must be exactly: 2 easy, 2 medium, 2 hard.',
                'Easy questions should use meaningful visible clues or source metadata, not one-word obvious object/color questions.',
                'Medium questions should require combining the image with football context from the title/source/category metadata.',
                'Hard questions should ask more specific football knowledge that is strongly supported by the image/title/source metadata.',
                'Avoid questions that require guessing a person if the face is unclear or the metadata does not identify them.',
                'Use plausible football distractors, not random other sports.',
              ].join('\n'),
            },
            {
              type: 'image_url',
              image_url: { url: imageRef },
            },
          ],
        },
      ],
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter failed: ${response.status} ${bodyText.slice(0, 500)}`);
  }

  const body = JSON.parse(bodyText) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`OpenRouter returned no content: ${bodyText.slice(0, 500)}`);
  }

  const parsed = JSON.parse(content) as { questions?: GeneratedQuestion[] };
  const questions = (parsed.questions ?? []).filter(isValidQuestion);
  return selectBalancedQuestions(questions);
}

function isValidQuestion(question: GeneratedQuestion): boolean {
  if (!question.prompt?.en || !Array.isArray(question.options) || question.options.length !== 4) return false;
  if (!DIFFICULTIES.includes(question.difficulty)) return false;
  const ids = question.options.map((option) => option.id);
  if (new Set(ids).size !== 4) return false;
  return question.options.filter((option) => option.is_correct).length === 1;
}

function selectBalancedQuestions(questions: GeneratedQuestion[]): GeneratedQuestion[] {
  const selected = DIFFICULTIES.flatMap((difficulty) =>
    questions
      .filter((question) => question.difficulty === difficulty)
      .slice(0, REQUIRED_DIFFICULTY_COUNT)
  );

  if (selected.length !== REQUIRED_QUESTIONS_PER_IMAGE) {
    throw new Error('AI did not return 2 easy, 2 medium, and 2 hard valid questions');
  }

  return selected;
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}

function withoutInlineImageData(item: PreviewItem): Omit<PreviewItem, 'dataUrl'> {
  const { dataUrl: _dataUrl, ...rest } = item;
  return rest;
}

function renderPreview(items: PreviewItem[], args: Args): string {
  const cards = items
    .map((item, itemIndex) => {
      const questionBlocks = item.questions
        .map((question, questionIndex) => {
          const options = question.options
            .map((option) => {
              const letter = option.id.toUpperCase();
              const cls = option.is_correct ? 'option correct' : 'option';
              return `<li class="${cls}"><span>${letter}</span>${escapeHtml(option.text.en)}</li>`;
            })
            .join('');
          return `
            <section class="question">
              <div class="question-meta">
                <span>${escapeHtml(question.difficulty)}</span>
                <span>confidence ${Math.round(question.confidence * 100)}%</span>
                <span>Q${questionIndex + 1}</span>
              </div>
              <h3>${escapeHtml(question.prompt.en)}</h3>
              <ol>${options}</ol>
              <p class="explanation">${escapeHtml(question.explanation.en)}</p>
            </section>
          `;
        })
        .join('');

      const error = item.error ? `<p class="error">${escapeHtml(item.error)}</p>` : '';

      return `
        <article class="card" data-preview-card="${itemIndex}">
          <div class="media">
            <img src="${escapeHtml(item.localUrl)}" alt="${escapeHtml(item.title)}" loading="lazy">
          </div>
          <div class="content">
            <div class="category-row">
              <span class="category">${escapeHtml(item.categoryName)}</span>
              <span class="provider">${escapeHtml(item.provider)}</span>
            </div>
            <h2>${escapeHtml(item.title)}</h2>
            ${questionBlocks}
            ${error}
            <footer>
              <a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer">source</a>
              <span>${escapeHtml(item.license ?? 'license unknown')}</span>
              <span>${Math.round(item.bytes / 1024)} KB</span>
            </footer>
          </div>
        </article>
      `;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Quizball Image Question Preview</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #080a0d;
      --panel: #11161d;
      --panel-2: #171e27;
      --text: #eef4f8;
      --muted: #8ea0ad;
      --line: #26313d;
      --accent: #35d07f;
      --warn: #f2b84b;
      --bad: #ff6b6b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 2;
      border-bottom: 1px solid var(--line);
      background: rgba(8, 10, 13, 0.92);
      backdrop-filter: blur(12px);
      padding: 18px 24px;
    }
    .header-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      width: min(1180px, 100%);
      margin: 0 auto;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }
    .counter {
      color: var(--muted);
      min-width: 54px;
      text-align: center;
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }
    button {
      appearance: none;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--text);
      min-width: 40px;
      height: 36px;
      padding: 0 12px;
      font: inherit;
      font-size: 14px;
      cursor: pointer;
    }
    button:hover:not(:disabled) {
      border-color: rgba(53, 208, 127, 0.55);
      color: var(--accent);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.42;
    }
    header h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
    }
    header p {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 13px;
    }
    main {
      width: min(1180px, calc(100% - 32px));
      margin: 24px auto 56px;
      display: grid;
      gap: 18px;
    }
    .card {
      display: none;
      grid-template-columns: minmax(260px, 420px) 1fr;
      align-items: start;
      gap: 0;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .card.active {
      display: grid;
    }
    .media {
      width: 100%;
      aspect-ratio: ${args.imageWidth} / ${args.imageHeight};
      align-self: start;
      background-color: #050607;
      background-image:
        linear-gradient(45deg, rgba(255,255,255,0.05) 25%, transparent 25%),
        linear-gradient(-45deg, rgba(255,255,255,0.05) 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.05) 75%),
        linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.05) 75%);
      background-position: 0 0, 0 8px, 8px -8px, -8px 0;
      background-size: 16px 16px;
      display: grid;
      place-items: center;
      border-right: 1px solid var(--line);
    }
    .media img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .content {
      padding: 20px;
      min-width: 0;
    }
    .category-row, .question-meta, footer {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .category, .provider, .question-meta span {
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--muted);
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 12px;
      line-height: 1;
    }
    .category {
      color: var(--accent);
      border-color: rgba(53, 208, 127, 0.35);
    }
    h2 {
      margin: 12px 0 18px;
      font-size: 18px;
      line-height: 1.3;
    }
    .question {
      border-top: 1px solid var(--line);
      padding-top: 16px;
      margin-top: 16px;
    }
    .question h3 {
      margin: 10px 0 14px;
      font-size: 18px;
      line-height: 1.4;
      font-weight: 650;
    }
    ol {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .option {
      min-height: 44px;
      display: flex;
      gap: 10px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0c1117;
      padding: 10px;
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    .option span {
      flex: 0 0 auto;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--panel-2);
      color: var(--muted);
      font-weight: 700;
      font-size: 12px;
    }
    .option.correct {
      border-color: rgba(53, 208, 127, 0.55);
      background: rgba(53, 208, 127, 0.08);
    }
    .option.correct span {
      background: var(--accent);
      color: #031008;
    }
    .explanation {
      color: var(--muted);
      margin: 12px 0 0;
      font-size: 13px;
      line-height: 1.5;
    }
    .error {
      color: var(--bad);
      background: rgba(255, 107, 107, 0.08);
      border: 1px solid rgba(255, 107, 107, 0.35);
      border-radius: 8px;
      padding: 10px;
    }
    footer {
      border-top: 1px solid var(--line);
      margin-top: 16px;
      padding-top: 14px;
      color: var(--muted);
      font-size: 12px;
    }
    footer a { color: var(--warn); text-decoration: none; }
    @media (max-width: 820px) {
      .header-inner { align-items: flex-start; flex-direction: column; }
      .card { grid-template-columns: 1fr; }
      .media { border-right: 0; border-bottom: 1px solid var(--line); }
      ol { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <div>
        <h1>Quizball Image Question Preview</h1>
        <p>${items.length} images · ${args.imageWidth}x${args.imageHeight} transparent PNG · model ${escapeHtml(args.skipAi ? 'AI skipped' : args.model)} · generated ${new Date().toISOString()}</p>
      </div>
      <nav class="controls" aria-label="Preview navigation">
        <button type="button" data-prev aria-label="Previous image">Prev</button>
        <span class="counter" data-counter>0 / 0</span>
        <button type="button" data-next aria-label="Next image">Next</button>
      </nav>
    </div>
  </header>
  <main>${cards || '<p>No preview items generated.</p>'}</main>
  <script>
    const cards = Array.from(document.querySelectorAll('[data-preview-card]'));
    const prevButton = document.querySelector('[data-prev]');
    const nextButton = document.querySelector('[data-next]');
    const counter = document.querySelector('[data-counter]');
    let current = 0;

    function showCard(index) {
      if (cards.length === 0) {
        if (counter) counter.textContent = '0 / 0';
        if (prevButton) prevButton.disabled = true;
        if (nextButton) nextButton.disabled = true;
        return;
      }

      current = (index + cards.length) % cards.length;
      cards.forEach((card, cardIndex) => {
        card.classList.toggle('active', cardIndex === current);
      });
      if (counter) counter.textContent = String(current + 1) + ' / ' + String(cards.length);
      const disabled = cards.length < 2;
      if (prevButton) prevButton.disabled = disabled;
      if (nextButton) nextButton.disabled = disabled;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    if (prevButton) prevButton.addEventListener('click', () => showCard(current - 1));
    if (nextButton) nextButton.addEventListener('click', () => showCard(current + 1));
    window.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') showCard(current - 1);
      if (event.key === 'ArrowRight') showCard(current + 1);
    });
    showCard(0);
  </script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!Number.isFinite(args.limitCategories) || args.limitCategories < 1) {
    throw new Error('--limit-categories must be a positive number');
  }
  if (!Number.isFinite(args.imagesPerCategory) || args.imagesPerCategory < 1) {
    throw new Error('--images-per-category must be a positive number');
  }
  if (!Number.isFinite(args.imageWidth) || args.imageWidth < 64) {
    throw new Error('--image-width must be at least 64');
  }
  if (!Number.isFinite(args.imageHeight) || args.imageHeight < 64) {
    throw new Error('--image-height must be at least 64');
  }

  const outDir = join(process.cwd(), args.outDir);
  const imageDir = join(outDir, 'images');
  mkdirSync(imageDir, { recursive: true });

  console.log(`Output: ${outDir}`);
  console.log(`Model : ${args.skipAi ? 'AI skipped' : args.model}`);
  console.log(`Images: ${args.imageWidth}x${args.imageHeight} transparent PNG`);

  const categories = await loadCategories(args.limitCategories, args.categorySlug);
  console.log(`Loaded ${categories.length} active categories`);

  const allCandidates: CandidateImage[] = [];
  const previewItems: PreviewItem[] = [];

  for (const category of categories) {
    const categoryName = getLocalizedText(category.name) || category.slug;
    console.log(`\n[${category.slug}] ${categoryName}`);

    const candidates: CandidateImage[] = [];
    const existing = categoryImageCandidate(category);
    if (existing) candidates.push(existing);

    const commonsNeeded = Math.max(0, args.imagesPerCategory - candidates.length);
    if (commonsNeeded > 0) {
      try {
        candidates.push(...await searchCommons(category, commonsNeeded));
      } catch (error) {
        console.log(`  commons search failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const selected = candidates.slice(0, args.imagesPerCategory);
    allCandidates.push(...selected);
    console.log(`  candidates: ${selected.length}`);

    for (const candidate of selected) {
      try {
        await sleep(DOWNLOAD_DELAY_MS);
        const downloaded = await downloadImage(candidate, imageDir, args.imageWidth, args.imageHeight);
        console.log(`  image ok: ${downloaded.title} (${Math.round(downloaded.bytes / 1024)} KB)`);
        let questions: GeneratedQuestion[];
        let error: string | null = null;
        if (args.skipAi) {
          questions = [fallbackQuestion(downloaded)];
        } else {
          try {
            questions = await generateQuestions(downloaded, args.model);
            console.log(`  ai ok: ${questions.length} question(s)`);
          } catch (aiError) {
            error = aiError instanceof Error ? aiError.message : String(aiError);
            questions = [fallbackQuestion(downloaded)];
            console.log(`  ai failed: ${error}`);
          }
        }
        previewItems.push({ ...downloaded, questions, error });
      } catch (error) {
        console.log(`  image failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  writeJsonl(join(outDir, 'candidates.jsonl'), allCandidates);
  writeJsonl(join(outDir, 'preview-items.jsonl'), previewItems.map(withoutInlineImageData));
  writeFileSync(join(outDir, 'index.html'), renderPreview(previewItems, args));

  console.log(`\nDone.`);
  console.log(`Preview: ${join(outDir, 'index.html')}`);
  console.log(`Data   : ${join(outDir, 'preview-items.jsonl')}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

// Keep this file executable through tsx even when bundled imports are tree-shaken.
void fileURLToPath(import.meta.url);
