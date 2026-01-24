/**
 * Integration tests for QuestionsRepo.updateWithPayload
 *
 * These tests verify actual JSONB behavior in the database.
 * Requires a running test database (DATABASE_URL in setup.ts).
 *
 * Run with:
 *   npm run docker:start  # Start test database
 *   npx vitest run tests/questions/questions-repo.integration.test.ts
 *
 * These tests are skipped if the database is not available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { I18nField, Json } from '../../src/db/types.js';
import '../setup.js';

// Dynamically import to avoid connection errors at module load
let sql: typeof import('../../src/db/index.js').sql;
let questionsRepo: typeof import('../../src/modules/questions/questions.repo.js').questionsRepo;

// Test category ID - will be created in beforeAll
let testCategoryId: string;

// Track created question IDs for cleanup
const createdQuestionIds: string[] = [];

// Flag to determine if DB is available
let dbAvailable = false;

// Check DB availability before running tests
beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;

    const repoModule = await import(
      '../../src/modules/questions/questions.repo.js'
    );
    questionsRepo = repoModule.questionsRepo;
  } catch {
    console.warn(
      '\n⚠️  Skipping integration tests: Database not available.\n' +
        '   Run `npm run docker:start` to start the test database.\n'
    );
  }
});

describe('QuestionsRepo.updateWithPayload Integration Tests', () => {
  beforeAll(async () => {
    if (!dbAvailable) return;

    // Create a test category for our questions
    const [category] = await sql<{ id: string }[]>`
      INSERT INTO categories (name, is_active)
      VALUES (${{ en: 'Test Category' }}::jsonb, true)
      RETURNING id
    `;
    testCategoryId = category.id;
  });

  afterAll(async () => {
    if (!dbAvailable) return;

    // Clean up created questions
    if (createdQuestionIds.length > 0) {
      await sql`
        DELETE FROM question_payloads WHERE question_id = ANY(${createdQuestionIds}::uuid[])
      `;
      await sql`
        DELETE FROM questions WHERE id = ANY(${createdQuestionIds}::uuid[])
      `;
    }

    // Clean up test category
    if (testCategoryId) {
      await sql`DELETE FROM categories WHERE id = ${testCategoryId}`;
    }

    // Close database connection
    await sql.end();
  });

  /**
   * Helper to create a test question and track it for cleanup
   */
  async function createTestQuestion(
    prompt: I18nField,
    explanation?: I18nField | null,
    payload?: Json
  ) {
    const question = await questionsRepo.createWithPayload(
      {
        categoryId: testCategoryId,
        type: 'mcq_single',
        difficulty: 'easy',
        status: 'draft',
        prompt,
        explanation,
      },
      payload
    );
    createdQuestionIds.push(question.id);
    return question;
  }

  /**
   * Helper to read question directly from DB to verify stored JSON
   */
  async function readQuestionFromDb(id: string) {
    const [row] = await sql<
      {
        id: string;
        prompt: Json;
        explanation: Json | null;
      }[]
    >`
      SELECT id, prompt, explanation
      FROM questions
      WHERE id = ${id}
    `;
    return row;
  }

  /**
   * Helper to read payload directly from DB
   */
  async function readPayloadFromDb(questionId: string) {
    const [row] = await sql<{ payload: Json }[]>`
      SELECT payload
      FROM question_payloads
      WHERE question_id = ${questionId}
    `;
    return row?.payload ?? null;
  }

  describe('prompt field JSONB behavior', () => {
    it('should store empty object {} as valid JSONB when prompt is {}', async () => {
      if (!dbAvailable) return;

      // Create question with initial prompt
      const question = await createTestQuestion({ en: 'Initial prompt' });

      // Update with empty object prompt
      const updated = await questionsRepo.updateWithPayload(
        question.id,
        { prompt: {} as I18nField },
        { type: 'mcq_single', options: [] }
      );

      expect(updated).not.toBeNull();

      // Verify DB-stored JSON is empty object
      const dbRow = await readQuestionFromDb(question.id);
      expect(dbRow.prompt).toEqual({});
      expect(JSON.stringify(dbRow.prompt)).toBe('{}');
    });

    it('should preserve existing prompt when prompt is undefined', async () => {
      if (!dbAvailable) return;

      const originalPrompt = { en: 'Original prompt', es: 'Pregunta original' };
      const question = await createTestQuestion(originalPrompt);

      // Update without prompt field (undefined)
      const updated = await questionsRepo.updateWithPayload(
        question.id,
        { status: 'published' }, // prompt is undefined
        { type: 'mcq_single', options: [] }
      );

      expect(updated).not.toBeNull();

      // Verify DB-stored prompt is preserved
      const dbRow = await readQuestionFromDb(question.id);
      expect(dbRow.prompt).toEqual(originalPrompt);
    });

    it('should update prompt with new value when provided', async () => {
      if (!dbAvailable) return;

      const question = await createTestQuestion({ en: 'Initial' });
      const newPrompt = { en: 'Updated prompt', fr: 'Question mise à jour' };

      const updated = await questionsRepo.updateWithPayload(
        question.id,
        { prompt: newPrompt },
        { type: 'mcq_single', options: [] }
      );

      expect(updated).not.toBeNull();

      // Verify DB-stored prompt is updated
      const dbRow = await readQuestionFromDb(question.id);
      expect(dbRow.prompt).toEqual(newPrompt);
    });
  });

  describe('explanation field JSONB behavior', () => {
    it('should clear explanation when explicitly set to null', async () => {
      if (!dbAvailable) return;

      const question = await createTestQuestion(
        { en: 'Question' },
        { en: 'Initial explanation' }
      );

      // Verify explanation exists
      let dbRow = await readQuestionFromDb(question.id);
      expect(dbRow.explanation).toEqual({ en: 'Initial explanation' });

      // Update with explicit null
      const updated = await questionsRepo.updateWithPayload(
        question.id,
        { explanation: null },
        { type: 'mcq_single', options: [] }
      );

      expect(updated).not.toBeNull();

      // Verify DB-stored explanation is null
      dbRow = await readQuestionFromDb(question.id);
      expect(dbRow.explanation).toBeNull();
    });

    it('should preserve existing explanation when undefined', async () => {
      if (!dbAvailable) return;

      const originalExplanation = { en: 'Keep this explanation' };
      const question = await createTestQuestion(
        { en: 'Question' },
        originalExplanation
      );

      // Update without explanation field (undefined)
      const updated = await questionsRepo.updateWithPayload(
        question.id,
        { status: 'published' }, // explanation is undefined
        { type: 'mcq_single', options: [] }
      );

      expect(updated).not.toBeNull();

      // Verify DB-stored explanation is preserved
      const dbRow = await readQuestionFromDb(question.id);
      expect(dbRow.explanation).toEqual(originalExplanation);
    });

    it('should update explanation with new value when provided', async () => {
      if (!dbAvailable) return;

      const question = await createTestQuestion(
        { en: 'Question' },
        { en: 'Old explanation' }
      );
      const newExplanation = { en: 'New explanation', de: 'Neue Erklärung' };

      const updated = await questionsRepo.updateWithPayload(
        question.id,
        { explanation: newExplanation },
        { type: 'mcq_single', options: [] }
      );

      expect(updated).not.toBeNull();

      // Verify DB-stored explanation is updated
      const dbRow = await readQuestionFromDb(question.id);
      expect(dbRow.explanation).toEqual(newExplanation);
    });
  });

  describe('payload upsert behavior', () => {
    it('should insert payload when none exists', async () => {
      if (!dbAvailable) return;

      // Create question without payload
      const question = await createTestQuestion({ en: 'No payload question' });

      // Verify no payload exists
      let payload = await readPayloadFromDb(question.id);
      expect(payload).toBeNull();

      // Update with payload
      const newPayload = {
        type: 'mcq_single',
        options: [{ id: 'opt1', text: { en: 'Option 1' }, is_correct: true }],
      };

      await questionsRepo.updateWithPayload(question.id, {}, newPayload);

      // Verify payload was inserted
      payload = await readPayloadFromDb(question.id);
      expect(payload).toEqual(newPayload);
    });

    it('should update existing payload (upsert)', async () => {
      if (!dbAvailable) return;

      const initialPayload = {
        type: 'mcq_single',
        options: [{ id: 'opt1', text: { en: 'Original' }, is_correct: false }],
      };
      const question = await createTestQuestion(
        { en: 'Question' },
        null,
        initialPayload
      );

      // Verify initial payload
      let payload = await readPayloadFromDb(question.id);
      expect(payload).toEqual(initialPayload);

      // Update with new payload
      const updatedPayload = {
        type: 'mcq_single',
        options: [
          { id: 'opt1', text: { en: 'Updated' }, is_correct: true },
          { id: 'opt2', text: { en: 'New option' }, is_correct: false },
        ],
      };

      await questionsRepo.updateWithPayload(question.id, {}, updatedPayload);

      // Verify payload was updated
      payload = await readPayloadFromDb(question.id);
      expect(payload).toEqual(updatedPayload);
    });
  });

  describe('full roundtrip test', () => {
    it('should create, update, and read back question with all fields correctly', async () => {
      if (!dbAvailable) return;

      // Step 1: Create question with initial data
      const initialPrompt = { en: 'What is 2+2?' };
      const initialExplanation = { en: 'Basic addition' };
      const initialPayload = {
        type: 'mcq_single',
        options: [
          { id: 'a', text: { en: '3' }, is_correct: false },
          { id: 'b', text: { en: '4' }, is_correct: true },
        ],
      };

      const created = await createTestQuestion(
        initialPrompt,
        initialExplanation,
        initialPayload
      );

      expect(created.id).toBeDefined();
      expect(created.prompt).toEqual(initialPrompt);
      expect(created.explanation).toEqual(initialExplanation);
      expect(created.payload).toEqual(initialPayload);

      // Verify in DB
      let dbQuestion = await readQuestionFromDb(created.id);
      let dbPayload = await readPayloadFromDb(created.id);
      expect(dbQuestion.prompt).toEqual(initialPrompt);
      expect(dbQuestion.explanation).toEqual(initialExplanation);
      expect(dbPayload).toEqual(initialPayload);

      // Step 2: Update with modified fields
      const updatedPrompt = { en: 'What is 2+2?', es: '¿Cuánto es 2+2?' };
      const updatedPayload = {
        type: 'mcq_single',
        options: [
          { id: 'a', text: { en: '3', es: '3' }, is_correct: false },
          { id: 'b', text: { en: '4', es: '4' }, is_correct: true },
          { id: 'c', text: { en: '5', es: '5' }, is_correct: false },
        ],
      };

      const updated = await questionsRepo.updateWithPayload(
        created.id,
        {
          prompt: updatedPrompt,
          status: 'published',
          // explanation is undefined - should preserve
        },
        updatedPayload
      );

      expect(updated).not.toBeNull();
      expect(updated!.prompt).toEqual(updatedPrompt);
      expect(updated!.status).toBe('published');
      // Explanation should be preserved (was not in update)
      expect(updated!.explanation).toEqual(initialExplanation);
      expect(updated!.payload).toEqual(updatedPayload);

      // Step 3: Verify all changes persisted in DB
      dbQuestion = await readQuestionFromDb(created.id);
      dbPayload = await readPayloadFromDb(created.id);

      expect(dbQuestion.prompt).toEqual(updatedPrompt);
      expect(dbQuestion.explanation).toEqual(initialExplanation); // Preserved
      expect(dbPayload).toEqual(updatedPayload);

      // Step 4: Update to clear explanation
      const finalUpdate = await questionsRepo.updateWithPayload(
        created.id,
        { explanation: null },
        updatedPayload
      );

      expect(finalUpdate).not.toBeNull();
      expect(finalUpdate!.explanation).toBeNull();

      // Verify in DB
      dbQuestion = await readQuestionFromDb(created.id);
      expect(dbQuestion.explanation).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should return null when updating non-existent question', async () => {
      if (!dbAvailable) return;

      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      const result = await questionsRepo.updateWithPayload(
        nonExistentId,
        { status: 'published' },
        { type: 'mcq_single', options: [] }
      );

      expect(result).toBeNull();
    });

    it('should handle complex nested JSON in payload', async () => {
      if (!dbAvailable) return;

      const question = await createTestQuestion({ en: 'Complex question' });

      const complexPayload = {
        type: 'mcq_single',
        options: [
          {
            id: 'opt1',
            text: { en: 'Option with "quotes"', es: "Opción con 'comillas'" },
            is_correct: true,
            metadata: {
              difficulty_score: 0.75,
              tags: ['math', 'algebra'],
              nested: { deep: { value: 123 } },
            },
          },
        ],
        hints: [{ en: 'Think about it' }],
        special_chars: '特殊字符 émojis 🎉',
      };

      await questionsRepo.updateWithPayload(question.id, {}, complexPayload);

      // Verify complex JSON is stored correctly
      const payload = await readPayloadFromDb(question.id);
      expect(payload).toEqual(complexPayload);
      expect((payload as Record<string, unknown>).special_chars).toBe(
        '特殊字符 émojis 🎉'
      );
      expect(
        (
          (payload as Record<string, unknown>).options as Array<
            Record<string, unknown>
          >
        )[0].metadata
      ).toEqual({
        difficulty_score: 0.75,
        tags: ['math', 'algebra'],
        nested: { deep: { value: 123 } },
      });
    });

    it('should handle empty payload object', async () => {
      if (!dbAvailable) return;

      const question = await createTestQuestion({ en: 'Question' });

      await questionsRepo.updateWithPayload(question.id, {}, {});

      const payload = await readPayloadFromDb(question.id);
      expect(payload).toEqual({});
      expect(JSON.stringify(payload)).toBe('{}');
    });
  });
});
