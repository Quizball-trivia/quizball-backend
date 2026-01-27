import { sql } from '../../db/index.js';
import type { Question, QuestionWithPayload, I18nField, Json } from '../../db/types.js';
import { logger } from '../../core/logger.js';

export interface CreateQuestionData {
  categoryId: string;
  type: string;
  difficulty: string;
  status?: string;
  prompt: I18nField;
  explanation?: I18nField | null;
  payload?: Json;
}

export interface UpdateQuestionData {
  categoryId?: string;
  type?: string;
  difficulty?: string;
  status?: string;
  prompt?: I18nField;
  explanation?: I18nField | null;
  payload?: Json;
}

export interface ListQuestionsFilter {
  categoryId?: string;
  status?: string;
  difficulty?: string;
  type?: string;
  search?: string;
}

export interface QuestionWithCategory extends Question {
  category_name: I18nField;
}

export interface ListQuestionsResult {
  questions: QuestionWithPayload[];
  total: number;
}

export const questionsRepo = {
  async list(
    filter?: ListQuestionsFilter,
    page = 1,
    limit = 20
  ): Promise<ListQuestionsResult> {
    const offset = (page - 1) * limit;

    // Use tagged template with conditional fragments
    const categoryFilter = filter?.categoryId ? sql`AND q.category_id = ${filter.categoryId}` : sql``;
    const statusFilter = filter?.status ? sql`AND q.status = ${filter.status}` : sql``;
    const difficultyFilter = filter?.difficulty ? sql`AND q.difficulty = ${filter.difficulty}` : sql``;
    const typeFilter = filter?.type ? sql`AND q.type = ${filter.type}` : sql``;
    const searchFilter = filter?.search
      ? sql`AND (q.prompt->>'en' ILIKE ${'%' + filter.search + '%'} OR q.prompt->>'ka' ILIKE ${'%' + filter.search + '%'})`
      : sql``;

    // Get paginated results with payload and total count in single query
    const results = await sql<(QuestionWithPayload & { total_count: string })[]>`
      SELECT q.*, qp.payload, COUNT(*) OVER() as total_count
      FROM questions q
      LEFT JOIN question_payloads qp ON qp.question_id = q.id
      WHERE 1=1
      ${categoryFilter}
      ${statusFilter}
      ${difficultyFilter}
      ${typeFilter}
      ${searchFilter}
      ORDER BY q.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const total = results.length > 0 ? parseInt(results[0].total_count, 10) : 0;
    const questions = results.map(({ total_count: _, ...q }) => q);

    return { questions, total };
  },

  async getById(id: string): Promise<QuestionWithPayload | null> {
    const [question] = await sql<QuestionWithPayload[]>`
      SELECT q.*, qp.payload
      FROM questions q
      LEFT JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.id = ${id}
    `;
    return question ?? null;
  },

  /**
   * Batch fetch questions by IDs with payloads.
   * More efficient than calling getById in a loop (avoids N+1 queries).
   * Returns a Map for O(1) lookup by ID (unordered).
   */
  async getByIds(ids: string[]): Promise<Map<string, QuestionWithPayload>> {
    if (ids.length === 0) return new Map();

    const results = await sql<QuestionWithPayload[]>`
      SELECT q.*, qp.payload
      FROM questions q
      LEFT JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.id = ANY(${sql.array(ids)}::uuid[])
    `;

    // Build Map for O(1) lookup
    return new Map(results.map(q => [q.id, q]));
  },

  async create(data: CreateQuestionData): Promise<Question> {
    const [question] = await sql<Question[]>`
      INSERT INTO questions (category_id, type, difficulty, status, prompt, explanation)
      VALUES (
        ${data.categoryId},
        ${data.type},
        ${data.difficulty},
        ${data.status ?? 'draft'},
        ${sql.json(data.prompt as unknown as Json)},
        ${data.explanation ? sql.json(data.explanation as unknown as Json) : null}
      )
      RETURNING *
    `;
    return question;
  },

  /**
   * Create question with payload in a single transaction.
   * Prevents orphaned questions if payload creation fails.
   * Uses JSON.stringify for JSONB fields to ensure proper serialization.
   */
  async createWithPayload(
    data: CreateQuestionData,
    payload?: Json
  ): Promise<QuestionWithPayload> {
    return sql.begin(async (tx) => {
      const questionResult = await tx.unsafe<Question[]>(
        `INSERT INTO questions (category_id, type, difficulty, status, prompt, explanation)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         RETURNING *`,
        [
          data.categoryId,
          data.type,
          data.difficulty,
          data.status ?? 'draft',
          JSON.stringify(data.prompt),
          data.explanation ? JSON.stringify(data.explanation) : null,
        ]
      );
      const question = questionResult[0];

      let questionPayload: Json | null = null;
      if (payload) {
        const payloadResult = await tx.unsafe<{ payload: Json }[]>(
          `INSERT INTO question_payloads (question_id, payload)
           VALUES ($1, $2::jsonb)
           RETURNING payload`,
          [question.id, JSON.stringify(payload)]
        );
        questionPayload = payloadResult[0].payload;
      }

      return { ...question, payload: questionPayload };
    });
  },

  async createPayload(questionId: string, payload: Json): Promise<void> {
    await sql`
      INSERT INTO question_payloads (question_id, payload)
      VALUES (${questionId}, ${sql.json(payload)})
    `;
  },

  async update(id: string, data: UpdateQuestionData): Promise<Question | null> {
    const [question] = await sql<Question[]>`
      UPDATE questions
      SET
        category_id = CASE WHEN ${data.categoryId !== undefined} THEN ${data.categoryId ?? ''} ELSE category_id END,
        type = CASE WHEN ${data.type !== undefined} THEN ${data.type ?? ''} ELSE type END,
        difficulty = CASE WHEN ${data.difficulty !== undefined} THEN ${data.difficulty ?? ''} ELSE difficulty END,
        status = CASE WHEN ${data.status !== undefined} THEN ${data.status ?? ''} ELSE status END,
        prompt = CASE WHEN ${data.prompt !== undefined} THEN ${sql.json(data.prompt as unknown as Json)}::jsonb ELSE prompt END,
        explanation = CASE WHEN ${data.explanation !== undefined} THEN ${data.explanation ? sql.json(data.explanation as unknown as Json) : null}::jsonb ELSE explanation END,
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return question ?? null;
  },

  async updatePayload(questionId: string, payload: Json): Promise<void> {
    // Upsert - insert if not exists, update if exists
    await sql`
      INSERT INTO question_payloads (question_id, payload)
      VALUES (${questionId}, ${sql.json(payload)})
      ON CONFLICT (question_id)
      DO UPDATE SET payload = ${sql.json(payload)}, updated_at = NOW()
    `;
  },

  /**
   * Update question with payload in a single transaction.
   * Ensures atomicity - both succeed or both fail.
   * Uses JSON.stringify for JSONB fields to ensure proper serialization.
   * Returns null if question not found.
   */
  async updateWithPayload(
    id: string,
    data: UpdateQuestionData,
    payload: Json
  ): Promise<QuestionWithPayload | null> {
    return sql.begin(async (tx) => {
      // Update question
      const questionResult = await tx.unsafe<Question[]>(
        `UPDATE questions
         SET
           category_id = CASE WHEN $2 THEN $3 ELSE category_id END,
           type = CASE WHEN $4 THEN $5 ELSE type END,
           difficulty = CASE WHEN $6 THEN $7 ELSE difficulty END,
           status = CASE WHEN $8 THEN $9 ELSE status END,
           prompt = CASE WHEN $10 THEN $11::jsonb ELSE prompt END,
           explanation = CASE WHEN $12 THEN $13::jsonb ELSE explanation END,
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          data.categoryId !== undefined,
          data.categoryId ?? '',
          data.type !== undefined,
          data.type ?? '',
          data.difficulty !== undefined,
          data.difficulty ?? '',
          data.status !== undefined,
          data.status ?? '',
          data.prompt !== undefined,
          data.prompt ? JSON.stringify(data.prompt) : null,
          data.explanation !== undefined,
          data.explanation ? JSON.stringify(data.explanation) : null,
        ]
      );

      if (questionResult.length === 0) {
        return null;
      }

      const question = questionResult[0];

      // Upsert payload
      const payloadResult = await tx.unsafe<{ payload: Json }[]>(
        `INSERT INTO question_payloads (question_id, payload)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (question_id)
         DO UPDATE SET payload = $2::jsonb, updated_at = NOW()
         RETURNING payload`,
        [id, JSON.stringify(payload)]
      );

      return { ...question, payload: payloadResult[0].payload };
    });
  },

  async updateStatus(id: string, status: string): Promise<Question | null> {
    const [question] = await sql<Question[]>`
      UPDATE questions
      SET status = ${status}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return question ?? null;
  },

  async delete(id: string): Promise<boolean> {
    // Payload will be deleted via CASCADE
    const result = await sql`
      DELETE FROM questions WHERE id = ${id}
    `;
    return result.count > 0;
  },

  /**
   * Find questions by an array of prompts (for duplicate checking).
   * Uses normalized prompt comparison (case-insensitive, trimmed).
   * Uses the provided locale key for prompt matching.
   * Returns questions with category information.
   */
  async findByPrompts(prompts: Json[], locale = 'en'): Promise<QuestionWithCategory[]> {
    // Normalize prompts for comparison (lowercase, trim)
    const normalizedPrompts = prompts.map(p => {
      const promptObj = p as I18nField;
      const text = promptObj[locale] || '';
      return text.toLowerCase().trim();
    }).filter(Boolean);

    if (normalizedPrompts.length === 0) return [];

    logger.debug(
      {
        promptCount: prompts.length,
        normalizedCount: normalizedPrompts.length,
        samplePromptLengths: normalizedPrompts.slice(0, 3).map((p) => p.length),
      },
      'findByPrompts: checking for duplicate prompts'
    );

    // Query database for matching questions with category names
    const results = await sql<QuestionWithCategory[]>`
      SELECT
        q.*,
        c.name as category_name
      FROM questions q
      JOIN categories c ON q.category_id = c.id
      WHERE q.prompt->>${locale} IS NOT NULL
        AND LOWER(TRIM(q.prompt->>${locale})) = ANY(${sql.array(normalizedPrompts)})
    `;

    logger.debug(
      {
        resultCount: results.length,
        sampleResults: results.slice(0, 3).map(r => ({
          id: r.id,
          prompt: r.prompt,
        })),
      },
      'findByPrompts: completed'
    );

    return results;
  },

  async exists(id: string): Promise<boolean> {
    const [result] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM questions WHERE id = ${id}) as exists
    `;
    return result?.exists ?? false;
  },

  async getByCategoryId(categoryId: string): Promise<Pick<Question, 'id' | 'prompt' | 'type' | 'difficulty'>[]> {
    return sql<Pick<Question, 'id' | 'prompt' | 'type' | 'difficulty'>[]>`
      SELECT id, prompt, type, difficulty FROM questions WHERE category_id = ${categoryId}
      ORDER BY created_at DESC
    `;
  },

  async deleteByCategoryId(categoryId: string): Promise<number> {
    const result = await sql`
      DELETE FROM questions WHERE category_id = ${categoryId}
    `;
    return result.count;
  },

  /**
   * Find duplicate questions using SQL GROUP BY aggregation.
   * More efficient than in-memory processing - scales to 100k+ questions.
   * Groups questions by normalized English prompt text (case-insensitive, trimmed).
   * Only detects duplicates for questions with English ('en') prompts.
   * Returns groups with metadata for further processing in service layer.
   */
  async findDuplicateGroups(
    filter?: Pick<ListQuestionsFilter, 'categoryId' | 'status'>
  ): Promise<{
    normalized_prompt: string;
    question_ids: string[];
    category_ids: string[];
    count: number;
  }[]> {
    const categoryFilter = filter?.categoryId
      ? sql`AND q.category_id = ${filter.categoryId}`
      : sql``;
    const statusFilter = filter?.status
      ? sql`AND q.status = ${filter.status}`
      : sql``;

    logger.debug(
      {
        filters: filter,
      },
      'findDuplicateGroups: starting SQL-based duplicate detection'
    );

    const results = await sql<{
      normalized_prompt: string;
      question_ids: string[];
      category_ids: string[];
      count: number;
    }[]>`
      SELECT
        LOWER(TRIM(q.prompt->>'en')) as normalized_prompt,
        array_agg(q.id ORDER BY q.created_at) as question_ids,
        array_agg(q.category_id ORDER BY q.created_at) as category_ids,
        COUNT(*)::int as count
      FROM questions q
      WHERE q.prompt->>'en' IS NOT NULL
        AND TRIM(q.prompt->>'en') != ''
        ${categoryFilter}
        ${statusFilter}
      GROUP BY LOWER(TRIM(q.prompt->>'en'))
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC, normalized_prompt
    `;

    logger.debug(
      {
        groupCount: results.length,
        totalDuplicates: results.reduce((sum, r) => sum + r.count, 0),
      },
      'findDuplicateGroups: completed'
    );

    return results;
  },
};
