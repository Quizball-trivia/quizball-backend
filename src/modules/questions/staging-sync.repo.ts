import postgres from 'postgres';
import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';

export type StagingQuestionSyncClient = postgres.Sql;

export interface StagingSyncQuestionRow {
  id: string;
  category_id: string;
  type: string;
  difficulty: string;
  status: string;
  prompt: Json;
  explanation: Json | null;
  created_at: string;
  updated_at: string;
}

export interface StagingSyncPayloadRow {
  id: string;
  question_id: string;
  payload: Json;
  created_at: string;
  updated_at: string;
}

type IdRow = { id: string };

export const stagingSyncRepo = {
  createTargetClient(databaseUrl: string): StagingQuestionSyncClient {
    return postgres(databaseUrl, {
      ssl: 'require',
      max: 1,
      connect_timeout: 20,
      idle_timeout: 5,
      prepare: false,
      onnotice: () => {},
    });
  },

  async closeTargetClient(target: StagingQuestionSyncClient): Promise<void> {
    await target.end({ timeout: 5 });
  },

  async getSourceQuestionsByIds(questionIds: string[]): Promise<StagingSyncQuestionRow[]> {
    return sql<StagingSyncQuestionRow[]>`
      SELECT id, category_id, type, difficulty, status, prompt, explanation, created_at, updated_at
      FROM questions
      WHERE id = ANY(${sql.array(questionIds)}::uuid[])
    `;
  },

  async getTargetQuestionIds(
    target: StagingQuestionSyncClient,
    questionIds: string[]
  ): Promise<string[]> {
    const rows = await target<IdRow[]>`
      SELECT id FROM questions WHERE id = ANY(${target.array(questionIds)}::uuid[])
    `;
    return rows.map((row) => row.id);
  },

  async getTargetCategoryIds(
    target: StagingQuestionSyncClient,
    categoryIds: string[]
  ): Promise<string[]> {
    const rows = await target<IdRow[]>`
      SELECT id FROM categories WHERE id = ANY(${target.array(categoryIds)}::uuid[])
    `;
    return rows.map((row) => row.id);
  },

  async getSourcePayloadsByQuestionIds(questionIds: string[]): Promise<StagingSyncPayloadRow[]> {
    return sql<StagingSyncPayloadRow[]>`
      SELECT id, question_id, payload, created_at, updated_at
      FROM question_payloads
      WHERE question_id = ANY(${sql.array(questionIds)}::uuid[])
    `;
  },

  async insertTargetQuestion(
    target: StagingQuestionSyncClient,
    question: StagingSyncQuestionRow
  ): Promise<number> {
    const result = await target`
      INSERT INTO questions (
        id,
        category_id,
        type,
        difficulty,
        status,
        prompt,
        explanation,
        created_at,
        updated_at,
        created_by
      )
      VALUES (
        ${question.id},
        ${question.category_id},
        ${question.type},
        ${question.difficulty},
        ${question.status},
        ${target.json(question.prompt)},
        ${question.explanation === null ? null : target.json(question.explanation)},
        ${question.created_at},
        ${question.updated_at},
        ${null}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    return result.count;
  },

  async insertTargetPayload(
    target: StagingQuestionSyncClient,
    payload: StagingSyncPayloadRow
  ): Promise<number> {
    const result = await target`
      INSERT INTO question_payloads (
        id,
        question_id,
        payload,
        created_at,
        updated_at
      )
      VALUES (
        ${payload.id},
        ${payload.question_id},
        ${target.json(payload.payload)},
        ${payload.created_at},
        ${payload.updated_at}
      )
      ON CONFLICT (question_id) DO NOTHING
    `;
    return result.count;
  },
};
