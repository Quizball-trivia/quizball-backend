import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import type { I18nField, Json } from '../../db/types.js';
import { isDeepStrictEqual } from 'node:util';
import { questionsRepo } from './questions.repo.js';
import { categoriesRepo } from '../categories/categories.repo.js';
import {
  getTranslationProvider,
  type TranslationInput,
  type TranslationOutput,
} from './translation.provider.js';

const BATCH_SIZE = 100;
const TARGET_LOCALE = 'ka';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseI18nField(raw: Json | string | null | undefined): I18nField | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as I18nField;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as I18nField;
  return null;
}

interface McqPayload {
  type: 'mcq_single';
  options: Array<{ id: string; text: I18nField; is_correct: boolean }>;
}

function parseMcqPayload(raw: Json | null): McqPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type !== 'mcq_single' || !Array.isArray(obj.options)) return null;
  return obj as unknown as McqPayload;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export const translationService = {
  /**
   * Translate a list of questions by ID. Skips already-translated ones.
   * Idempotent — safe to call multiple times.
   */
  async translateQuestions(
    questionIds: string[]
  ): Promise<{ translated: number; skipped: number; failed: number }> {
    const provider = getTranslationProvider();
    if (!provider.isConfigured()) {
      logger.warn('Translation skipped: OpenRouter API key not configured');
      return { translated: 0, skipped: questionIds.length, failed: 0 };
    }

    const questionMap = await questionsRepo.getByIds(questionIds);
    let translated = 0;
    let skipped = 0;
    let failed = 0;

    // Filter to questions that need translation
    const pending: Array<{
      id: string;
      prompt: I18nField;
      explanation: I18nField | null;
      payload: McqPayload | null;
      translatableOptionIndexes: number[];
    }> = [];

    for (const id of questionIds) {
      const q = questionMap.get(id);
      if (!q) {
        skipped++;
        continue;
      }

      const prompt = parseI18nField(q.prompt);
      if (!prompt?.en || prompt[TARGET_LOCALE]) {
        skipped++;
        continue;
      }

      pending.push({
        id: q.id,
        prompt,
        explanation: parseI18nField(q.explanation),
        payload: parseMcqPayload(q.payload),
        translatableOptionIndexes: [],
      });
    }

    // Process in batches
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);

      const inputs: TranslationInput[] = batch.map((q) => {
        const translatableOptions: string[] = [];
        const translatableOptionIndexes: number[] = [];

        if (q.payload?.options) {
          q.payload.options.forEach((option, idx) => {
            const englishText =
              option && typeof option === 'object' && option.text && typeof option.text === 'object'
                ? (option.text as I18nField).en
                : undefined;

            if (englishText) {
              translatableOptions.push(englishText);
              translatableOptionIndexes.push(idx);
              return;
            }

            logger.warn(
              {
                questionId: q.id,
                optionId: option?.id,
                optionIndex: idx,
              },
              'Skipping option translation due to missing English option text'
            );
          });
        }

        q.translatableOptionIndexes = translatableOptionIndexes;

        return {
          id: q.id,
          prompt: q.prompt.en!,
          options: translatableOptions.length > 0 ? translatableOptions : undefined,
          explanation: q.explanation?.en || undefined,
        };
      });

      try {
        const translations = await provider.translateQuestions(inputs);

        for (const t of translations) {
          const original = batch.find((q) => q.id === t.id);
          if (!original) continue;

          try {
            await applyTranslation(original, t);
            translated++;
          } catch (err) {
            logger.error({ questionId: t.id, error: err }, 'Failed to apply translation');
            failed++;
          }
        }
      } catch (err) {
        logger.error({ batchStart: i, batchSize: batch.length, error: err }, 'Translation batch failed');
        failed += batch.length;
      }
    }

    logger.info({ translated, skipped, failed, total: questionIds.length }, 'Question translation completed');
    return { translated, skipped, failed };
  },

  /**
   * Translate categories that have "en" but no "ka".
   */
  async translateCategories(categoryIds: string[]): Promise<number> {
    const provider = getTranslationProvider();
    if (!provider.isConfigured() || categoryIds.length === 0) return 0;

    const categories = await categoriesRepo.listByIds(categoryIds);

    const needsTranslation = categories.filter((c) => {
      const name = parseI18nField(c.name);
      return name?.en && !name[TARGET_LOCALE];
    });

    if (needsTranslation.length === 0) return 0;

    const inputs = needsTranslation.map((c) => {
      const name = parseI18nField(c.name)!;
      return { id: c.id, name: name.en! };
    });

    try {
      const translations = await provider.translateCategories(inputs);
      let count = 0;

      for (const t of translations) {
        const original = needsTranslation.find((c) => c.id === t.id);
        if (!original) continue;

        const name = parseI18nField(original.name);
        if (!name) continue;

        const merged = { ...name, [TARGET_LOCALE]: t.name };
        await sql`
          UPDATE categories SET name = ${sql.json(merged)}, updated_at = NOW() WHERE id = ${t.id}
        `;
        count++;
      }

      logger.info({ count, total: categoryIds.length }, 'Category translation completed');
      return count;
    } catch (err) {
      logger.error({ error: err }, 'Category translation failed');
      return 0;
    }
  },

  /**
   * Fire-and-forget: translate questions + their category after bulk upload.
   */
  async translateInBackground(questionIds: string[], categoryId: string): Promise<void> {
    try {
      await this.translateCategories([categoryId]);
      await this.translateQuestions(questionIds);
    } catch (err) {
      logger.error({ error: err, questionCount: questionIds.length, categoryId }, 'Background translation failed');
    }
  },

  /**
   * Get counts of items needing translation (fast query, no translation).
   */
  async getBackfillCounts(): Promise<{ questions: number; categories: number }> {
    const [qRow] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM questions
      WHERE prompt->>'en' IS NOT NULL
        AND (prompt->>'ka' IS NULL OR prompt->>'ka' = '')
    `;
    const [cRow] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM categories
      WHERE name->>'en' IS NOT NULL
        AND (name->>'ka' IS NULL OR name->>'ka' = '')
    `;
    return {
      questions: parseInt(qRow?.count ?? '0', 10),
      categories: parseInt(cRow?.count ?? '0', 10),
    };
  },

  /**
   * Backfill: translate ALL questions that have "en" but no "ka".
   */
  async backfillAll(): Promise<{
    translated: number;
    skipped: number;
    failed: number;
    categories: number;
  }> {
    const untranslated = await sql<{ id: string }[]>`
      SELECT id FROM questions
      WHERE prompt->>'en' IS NOT NULL
        AND (prompt->>'ka' IS NULL OR prompt->>'ka' = '')
      ORDER BY created_at ASC
    `;

    const questionIds = untranslated.map((q) => q.id);
    logger.info({ count: questionIds.length }, 'Starting translation backfill');

    const result = await this.translateQuestions(questionIds);

    // Also backfill categories
    const untranslatedCats = await sql<{ id: string }[]>`
      SELECT id FROM categories
      WHERE name->>'en' IS NOT NULL
        AND (name->>'ka' IS NULL OR name->>'ka' = '')
    `;

    const catCount = await this.translateCategories(untranslatedCats.map((c) => c.id));

    return { ...result, categories: catCount };
  },
};

// ─── Internal ────────────────────────────────────────────────────────────────

async function applyTranslation(
  original: {
    id: string;
    prompt: I18nField;
    explanation: I18nField | null;
    payload: McqPayload | null;
    translatableOptionIndexes?: number[];
  },
  translation: TranslationOutput
): Promise<void> {
  const newPrompt = { ...original.prompt, [TARGET_LOCALE]: translation.prompt };

  const newExplanation =
    translation.explanation && original.explanation
      ? { ...original.explanation, [TARGET_LOCALE]: translation.explanation }
      : original.explanation;

  // Merge "ka" into MCQ option texts
  let newPayload: Json | null = original.payload as Json | null;
  if (original.payload && translation.options) {
    const translatedByOriginalIndex = new Map<number, string>();
    const optionIndexes = original.translatableOptionIndexes ?? [];

    optionIndexes.forEach((optionIdx, translatedIdx) => {
      const translatedText = translation.options?.[translatedIdx];
      if (translatedText) {
        translatedByOriginalIndex.set(optionIdx, translatedText);
      }
    });

    const updatedOptions = original.payload.options.map((opt, idx) => {
      const translated = translatedByOriginalIndex.get(idx);
      if (!translated) return opt;

      return {
        ...opt,
        text: {
          ...opt.text,
          [TARGET_LOCALE]: translated,
        },
      };
    });
    newPayload = { ...original.payload, options: updatedOptions } as unknown as Json;
  }

  // Execute both updates in a single transaction for atomicity
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `UPDATE questions
       SET prompt = $1::jsonb,
           explanation = $2::jsonb,
           updated_at = NOW()
       WHERE id = $3`,
      [
        JSON.stringify(newPrompt),
        newExplanation ? JSON.stringify(newExplanation) : null,
        original.id,
      ]
    );

    if (newPayload && !isDeepStrictEqual(newPayload, original.payload as Json | null)) {
      await tx.unsafe(
        `UPDATE question_payloads
         SET payload = $1::jsonb,
             updated_at = NOW()
         WHERE question_id = $2`,
        [JSON.stringify(newPayload), original.id]
      );
    }
  });
}
