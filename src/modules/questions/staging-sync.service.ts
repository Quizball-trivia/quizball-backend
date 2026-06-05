import { config } from '../../core/config.js';
import { BadRequestError, ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { stagingSyncRepo } from './staging-sync.repo.js';
import type { SyncQuestionsToStagingResponse } from './questions.schemas.js';

const PROD_PROJECT_REF = 'lfbwhxvwubzeqkztghok';
const STAGING_PROJECT_REF = 'nsdfiprfmhdqhbfxfwpv';

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function getStagingDatabaseUrl(): string {
  if (!config.STAGING_DATABASE_URL) {
    throw new ExternalServiceError('Staging question sync is not configured. Set STAGING_DATABASE_URL on the backend.');
  }

  if (!config.DATABASE_URL) {
    throw new ExternalServiceError('Primary database is not configured.');
  }

  if (config.STAGING_DATABASE_URL === config.DATABASE_URL) {
    throw new BadRequestError('Staging question sync target cannot be the same database as the source.');
  }

  if (!config.DATABASE_URL.includes(PROD_PROJECT_REF)) {
    throw new BadRequestError('Staging question sync source must be the production database.', {
      expected_project_ref: PROD_PROJECT_REF,
    });
  }

  if (!config.STAGING_DATABASE_URL.includes(STAGING_PROJECT_REF)) {
    throw new BadRequestError('Staging question sync target must be the staging database.', {
      expected_project_ref: STAGING_PROJECT_REF,
    });
  }

  if (config.STAGING_DATABASE_URL.includes(PROD_PROJECT_REF)) {
    throw new BadRequestError('Staging question sync target cannot point at the production database.');
  }

  return config.STAGING_DATABASE_URL;
}

export const stagingSyncService = {
  async syncQuestions(questionIds: string[]): Promise<SyncQuestionsToStagingResponse> {
    const requestedIds = uniqueIds(questionIds);
    const target = stagingSyncRepo.createTargetClient(getStagingDatabaseUrl());

    try {
      const questions = await stagingSyncRepo.getSourceQuestionsByIds(requestedIds);

      const sourceIds = new Set(questions.map((question) => question.id));
      const missingQuestions = requestedIds.filter((id) => !sourceIds.has(id));

      if (questions.length === 0) {
        return {
          requested: requestedIds.length,
          source_found: 0,
          already_present: 0,
          inserted_questions: 0,
          inserted_payloads: 0,
          missing_questions: missingQuestions,
        };
      }

      const existingTargetIds = new Set(
        await stagingSyncRepo.getTargetQuestionIds(target, questions.map((question) => question.id))
      );
      const questionsToInsert = questions.filter((question) => !existingTargetIds.has(question.id));

      if (questionsToInsert.length === 0) {
        return {
          requested: requestedIds.length,
          source_found: questions.length,
          already_present: existingTargetIds.size,
          inserted_questions: 0,
          inserted_payloads: 0,
          missing_questions: missingQuestions,
        };
      }

      const categoryIds = uniqueIds(questionsToInsert.map((question) => question.category_id));
      const existingCategoryIds = new Set(
        await stagingSyncRepo.getTargetCategoryIds(target, categoryIds)
      );
      const missingCategories = categoryIds.filter((id) => !existingCategoryIds.has(id));
      if (missingCategories.length > 0) {
        throw new BadRequestError('Cannot sync questions to staging because some categories are missing in staging.', {
          missing_categories: missingCategories,
        });
      }

      const payloads = await stagingSyncRepo.getSourcePayloadsByQuestionIds(
        questionsToInsert.map((question) => question.id)
      );

      let insertedQuestions = 0;
      let insertedPayloads = 0;

      for (const question of questionsToInsert) {
        insertedQuestions += await stagingSyncRepo.insertTargetQuestion(target, question);
      }

      for (const payload of payloads) {
        insertedPayloads += await stagingSyncRepo.insertTargetPayload(target, payload);
      }

      const response = {
        requested: requestedIds.length,
        source_found: questions.length,
        already_present: existingTargetIds.size,
        inserted_questions: insertedQuestions,
        inserted_payloads: insertedPayloads,
        missing_questions: missingQuestions,
      };

      logger.info(response, 'Synced questions to staging');
      return response;
    } finally {
      await stagingSyncRepo.closeTargetClient(target);
    }
  },
};
