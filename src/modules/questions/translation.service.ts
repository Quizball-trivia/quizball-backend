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
import { questionPayloadSchema, type QuestionPayload } from './questions.schemas.js';

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

function parseQuestionPayload(raw: Json | null): QuestionPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parsed = questionPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

type TranslationFieldDescriptor =
  | { kind: 'mcq_option'; optionIndex: number }
  | { kind: 'true_false_option'; optionIndex: 0 | 1 }
  | { kind: 'imposter_option'; optionIndex: number }
  | { kind: 'countdown_prompt' }
  | { kind: 'countdown_display'; groupIndex: number }
  | { kind: 'clue_display_answer' }
  | { kind: 'clue_content'; clueIndex: number }
  | { kind: 'put_prompt' }
  | { kind: 'put_label'; itemIndex: number }
  | { kind: 'put_details'; itemIndex: number }
  | { kind: 'career_path_club'; clubIndex: number }
  | { kind: 'career_path_display_answer' }
  | { kind: 'high_low_stat_label' }
  | { kind: 'high_low_left_name'; matchupIndex: number }
  | { kind: 'high_low_right_name'; matchupIndex: number }
  | { kind: 'football_logic_prompt' }
  | { kind: 'football_logic_display_answer' }
  | { kind: 'football_logic_explanation' };

function normalizeAcceptedAnswer(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractTranslatableFields(payload: QuestionPayload | null): {
  texts: string[];
  descriptors: TranslationFieldDescriptor[];
} {
  if (!payload) {
    return { texts: [], descriptors: [] };
  }

  const texts: string[] = [];
  const descriptors: TranslationFieldDescriptor[] = [];

  if (payload.type === 'mcq_single') {
    payload.options.forEach((option, optionIndex) => {
      if (option.text.en) {
        texts.push(option.text.en);
        descriptors.push({ kind: 'mcq_option', optionIndex });
      }
    });
    return { texts, descriptors };
  }

  if (payload.type === 'true_false') {
    payload.options.forEach((option, optionIndex) => {
      if (option.text.en) {
        texts.push(option.text.en);
        descriptors.push({ kind: 'true_false_option', optionIndex: optionIndex as 0 | 1 });
      }
    });
    return { texts, descriptors };
  }

  if (payload.type === 'imposter_multi_select') {
    payload.options.forEach((option, optionIndex) => {
      if (option.text.en) {
        texts.push(option.text.en);
        descriptors.push({ kind: 'imposter_option', optionIndex });
      }
    });
    return { texts, descriptors };
  }

  if (payload.type === 'countdown_list') {
    if (payload.prompt.en) {
      texts.push(payload.prompt.en);
      descriptors.push({ kind: 'countdown_prompt' });
    }
    payload.answer_groups.forEach((group, groupIndex) => {
      if (group.display.en) {
        texts.push(group.display.en);
        descriptors.push({ kind: 'countdown_display', groupIndex });
      }
    });
    return { texts, descriptors };
  }

  if (payload.type === 'clue_chain') {
    if (payload.display_answer.en) {
      texts.push(payload.display_answer.en);
      descriptors.push({ kind: 'clue_display_answer' });
    }
    payload.clues.forEach((clue, clueIndex) => {
      if (clue.content.en) {
        texts.push(clue.content.en);
        descriptors.push({ kind: 'clue_content', clueIndex });
      }
    });
    return { texts, descriptors };
  }

  if (payload.type === 'put_in_order') {
    if (payload.prompt.en) {
      texts.push(payload.prompt.en);
      descriptors.push({ kind: 'put_prompt' });
    }
    payload.items.forEach((item, itemIndex) => {
      if (item.label.en) {
        texts.push(item.label.en);
        descriptors.push({ kind: 'put_label', itemIndex });
      }
      if (item.details?.en) {
        texts.push(item.details.en);
        descriptors.push({ kind: 'put_details', itemIndex });
      }
    });
  }

  if (payload.type === 'career_path') {
    payload.clubs.forEach((club, clubIndex) => {
      if (club.en) {
        texts.push(club.en);
        descriptors.push({ kind: 'career_path_club', clubIndex });
      }
    });
    if (payload.display_answer.en) {
      texts.push(payload.display_answer.en);
      descriptors.push({ kind: 'career_path_display_answer' });
    }
    return { texts, descriptors };
  }

  if (payload.type === 'high_low') {
    if (payload.stat_label.en) {
      texts.push(payload.stat_label.en);
      descriptors.push({ kind: 'high_low_stat_label' });
    }
    payload.matchups.forEach((matchup, matchupIndex) => {
      if (matchup.left_name.en) {
        texts.push(matchup.left_name.en);
        descriptors.push({ kind: 'high_low_left_name', matchupIndex });
      }
      if (matchup.right_name.en) {
        texts.push(matchup.right_name.en);
        descriptors.push({ kind: 'high_low_right_name', matchupIndex });
      }
    });
    return { texts, descriptors };
  }

  if (payload.type === 'football_logic') {
    if (payload.prompt?.en) {
      texts.push(payload.prompt.en);
      descriptors.push({ kind: 'football_logic_prompt' });
    }
    if (payload.display_answer.en) {
      texts.push(payload.display_answer.en);
      descriptors.push({ kind: 'football_logic_display_answer' });
    }
    if (payload.explanation?.en) {
      texts.push(payload.explanation.en);
      descriptors.push({ kind: 'football_logic_explanation' });
    }
  }

  return { texts, descriptors };
}

function payloadNeedsTranslation(payload: QuestionPayload | null): boolean {
  if (!payload) return false;

  if (payload.type === 'mcq_single' || payload.type === 'true_false' || payload.type === 'imposter_multi_select') {
    return payload.options.some((option) => option.text.en && !option.text[TARGET_LOCALE]);
  }

  if (payload.type === 'countdown_list') {
    return Boolean(
      (payload.prompt.en && !payload.prompt[TARGET_LOCALE])
      || payload.answer_groups.some((group) => group.display.en && !group.display[TARGET_LOCALE])
    );
  }

  if (payload.type === 'clue_chain') {
    return Boolean(
      (payload.display_answer.en && !payload.display_answer[TARGET_LOCALE])
      || payload.clues.some((clue) => clue.content.en && !clue.content[TARGET_LOCALE])
    );
  }

  if (payload.type === 'put_in_order') {
    return Boolean(
      (payload.prompt.en && !payload.prompt[TARGET_LOCALE])
      || payload.items.some((item) =>
        (item.label.en && !item.label[TARGET_LOCALE]) || (item.details?.en && !item.details[TARGET_LOCALE])
      )
    );
  }

  if (payload.type === 'career_path') {
    return Boolean(
      (payload.display_answer.en && !payload.display_answer[TARGET_LOCALE])
      || payload.clubs.some((club) => club.en && !club[TARGET_LOCALE])
    );
  }

  if (payload.type === 'high_low') {
    return Boolean(
      (payload.stat_label.en && !payload.stat_label[TARGET_LOCALE])
      || payload.matchups.some((matchup) =>
        (matchup.left_name.en && !matchup.left_name[TARGET_LOCALE])
        || (matchup.right_name.en && !matchup.right_name[TARGET_LOCALE])
      )
    );
  }

  if (payload.type === 'football_logic') {
    return Boolean(
      (payload.prompt?.en && !payload.prompt[TARGET_LOCALE])
      || (payload.display_answer.en && !payload.display_answer[TARGET_LOCALE])
      || (payload.explanation?.en && !payload.explanation[TARGET_LOCALE])
    );
  }

  return false;
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
      payload: QuestionPayload | null;
      translationDescriptors: TranslationFieldDescriptor[];
    }> = [];

    for (const id of questionIds) {
      const q = questionMap.get(id);
      if (!q) {
        skipped++;
        continue;
      }

      const prompt = parseI18nField(q.prompt);
      const explanation = parseI18nField(q.explanation);
      const payload = parseQuestionPayload(q.payload);

      const needsPrompt = Boolean(prompt?.en && !prompt[TARGET_LOCALE]);
      const needsExplanation = Boolean(explanation?.en && !explanation[TARGET_LOCALE]);
      const needsPayload = payloadNeedsTranslation(payload);

      if (!prompt?.en || (!needsPrompt && !needsExplanation && !needsPayload)) {
        skipped++;
        continue;
      }

      const { descriptors } = extractTranslatableFields(payload);

      pending.push({
        id: q.id,
        prompt,
        explanation,
        payload,
        translationDescriptors: descriptors,
      });
    }

    // Process in batches
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);

      const inputs: TranslationInput[] = batch.map((q) => {
        const { texts, descriptors } = extractTranslatableFields(q.payload);
        q.translationDescriptors = descriptors;

        return {
          id: q.id,
          prompt: q.prompt.en!,
          options: texts.length > 0 ? texts : undefined,
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
    const questionRows = await sql<{
      id: string;
      prompt: Json | null;
      explanation: Json | null;
      payload: Json | null;
    }[]>`
      SELECT q.id, q.prompt, q.explanation, qp.payload
      FROM questions q
      LEFT JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.prompt->>'en' IS NOT NULL
    `;
    const [cRow] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM categories
      WHERE name->>'en' IS NOT NULL
        AND (name->>'ka' IS NULL OR name->>'ka' = '')
    `;
    return {
      questions: questionRows.filter((q) => {
        const prompt = parseI18nField(q.prompt);
        const explanation = parseI18nField(q.explanation);
        const payload = parseQuestionPayload(q.payload);

        return Boolean(
          (prompt?.en && !prompt[TARGET_LOCALE])
          || (explanation?.en && !explanation[TARGET_LOCALE])
          || payloadNeedsTranslation(payload)
        );
      }).length,
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
    const questionRows = await sql<{
      id: string;
      prompt: Json | null;
      explanation: Json | null;
      payload: Json | null;
    }[]>`
      SELECT q.id, q.prompt, q.explanation, qp.payload
      FROM questions q
      LEFT JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.prompt->>'en' IS NOT NULL
      ORDER BY q.created_at ASC
    `;

    const questionIds = questionRows
      .filter((q) => {
        const prompt = parseI18nField(q.prompt);
        const explanation = parseI18nField(q.explanation);
        const payload = parseQuestionPayload(q.payload);

        return Boolean(
          (prompt?.en && !prompt[TARGET_LOCALE])
          || (explanation?.en && !explanation[TARGET_LOCALE])
          || payloadNeedsTranslation(payload)
        );
      })
      .map((q) => q.id);
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
    payload: QuestionPayload | null;
    translationDescriptors: TranslationFieldDescriptor[];
  },
  translation: TranslationOutput
): Promise<void> {
  const newPrompt = { ...original.prompt, [TARGET_LOCALE]: translation.prompt };

  const newExplanation =
    translation.explanation && original.explanation
      ? { ...original.explanation, [TARGET_LOCALE]: translation.explanation }
      : original.explanation;

  let newPayload: QuestionPayload | null = original.payload;
  if (original.payload && translation.options?.length) {
    const translatedEntries = original.translationDescriptors
      .map((descriptor, index) => ({
        descriptor,
        text: translation.options?.[index],
      }))
      .filter((entry): entry is { descriptor: TranslationFieldDescriptor; text: string } => Boolean(entry.text));

    if (translatedEntries.length > 0) {
      const payload = structuredClone(original.payload) as QuestionPayload;

      for (const entry of translatedEntries) {
        const translated = entry.text;

        switch (entry.descriptor.kind) {
          case 'mcq_option': {
            if (payload.type === 'mcq_single') {
              const option = payload.options[entry.descriptor.optionIndex];
              if (option) {
                option.text = { ...option.text, [TARGET_LOCALE]: translated };
              }
            }
            break;
          }
          case 'true_false_option': {
            if (payload.type === 'true_false') {
              const option = payload.options[entry.descriptor.optionIndex];
              if (option) {
                option.text = { ...option.text, [TARGET_LOCALE]: translated };
              }
            }
            break;
          }
          case 'imposter_option': {
            if (payload.type === 'imposter_multi_select') {
              const option = payload.options[entry.descriptor.optionIndex];
              if (option) {
                option.text = { ...option.text, [TARGET_LOCALE]: translated };
              }
            }
            break;
          }
          case 'countdown_prompt':
            if (payload.type === 'countdown_list') {
              payload.prompt = { ...payload.prompt, [TARGET_LOCALE]: translated };
            }
            break;
          case 'countdown_display':
            if (payload.type === 'countdown_list') {
              const group = payload.answer_groups[entry.descriptor.groupIndex];
              if (group) {
                group.display = { ...group.display, [TARGET_LOCALE]: translated };
                const normalized = normalizeAcceptedAnswer(translated);
                if (
                  normalized
                  && !group.accepted_answers.some((answer) => normalizeAcceptedAnswer(answer) === normalized)
                ) {
                  group.accepted_answers = [...group.accepted_answers, translated];
                }
              }
            }
            break;
          case 'clue_display_answer':
            if (payload.type === 'clue_chain') {
              payload.display_answer = { ...payload.display_answer, [TARGET_LOCALE]: translated };
              const normalized = normalizeAcceptedAnswer(translated);
              if (
                normalized
                && !payload.accepted_answers.some((answer) => normalizeAcceptedAnswer(answer) === normalized)
              ) {
                payload.accepted_answers = [...payload.accepted_answers, translated];
              }
            }
            break;
          case 'clue_content':
            if (payload.type === 'clue_chain') {
              const clue = payload.clues[entry.descriptor.clueIndex];
              if (clue) {
                clue.content = { ...clue.content, [TARGET_LOCALE]: translated };
              }
            }
            break;
          case 'put_prompt':
            if (payload.type === 'put_in_order') {
              payload.prompt = { ...payload.prompt, [TARGET_LOCALE]: translated };
            }
            break;
          case 'put_label':
            if (payload.type === 'put_in_order') {
              const item = payload.items[entry.descriptor.itemIndex];
              if (item) {
                item.label = { ...item.label, [TARGET_LOCALE]: translated };
              }
            }
            break;
          case 'put_details':
            if (payload.type === 'put_in_order') {
              const item = payload.items[entry.descriptor.itemIndex];
              if (item?.details) {
                item.details = { ...item.details, [TARGET_LOCALE]: translated };
              }
            }
            break;
          case 'career_path_club':
            if (payload.type === 'career_path') {
              const club = payload.clubs[entry.descriptor.clubIndex];
              if (club) {
                payload.clubs[entry.descriptor.clubIndex] = { ...club, [TARGET_LOCALE]: translated };
              }
            }
            break;
          case 'career_path_display_answer':
            if (payload.type === 'career_path') {
              payload.display_answer = { ...payload.display_answer, [TARGET_LOCALE]: translated };
              const normalized = normalizeAcceptedAnswer(translated);
              if (
                normalized
                && !payload.accepted_answers.some((answer) => normalizeAcceptedAnswer(answer) === normalized)
              ) {
                payload.accepted_answers = [...payload.accepted_answers, translated];
              }
            }
            break;
          case 'high_low_stat_label':
            if (payload.type === 'high_low') {
              payload.stat_label = { ...payload.stat_label, [TARGET_LOCALE]: translated };
            }
            break;
          case 'high_low_left_name':
            if (payload.type === 'high_low') {
              const matchup = payload.matchups[entry.descriptor.matchupIndex];
              if (matchup) {
                matchup.left_name = { ...matchup.left_name, [TARGET_LOCALE]: translated };
              }
            }
            break;
          case 'high_low_right_name':
            if (payload.type === 'high_low') {
              const matchup = payload.matchups[entry.descriptor.matchupIndex];
              if (matchup) {
                matchup.right_name = { ...matchup.right_name, [TARGET_LOCALE]: translated };
              }
            }
            break;
          case 'football_logic_prompt':
            if (payload.type === 'football_logic' && payload.prompt) {
              payload.prompt = { ...payload.prompt, [TARGET_LOCALE]: translated };
            }
            break;
          case 'football_logic_display_answer':
            if (payload.type === 'football_logic') {
              payload.display_answer = { ...payload.display_answer, [TARGET_LOCALE]: translated };
              const normalized = normalizeAcceptedAnswer(translated);
              if (
                normalized
                && !payload.accepted_answers.some((answer) => normalizeAcceptedAnswer(answer) === normalized)
              ) {
                payload.accepted_answers = [...payload.accepted_answers, translated];
              }
            }
            break;
          case 'football_logic_explanation':
            if (payload.type === 'football_logic' && payload.explanation) {
              payload.explanation = { ...payload.explanation, [TARGET_LOCALE]: translated };
            }
            break;
        }
      }

      newPayload = payload;
    }
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

    if (newPayload && !isDeepStrictEqual(newPayload, original.payload)) {
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
