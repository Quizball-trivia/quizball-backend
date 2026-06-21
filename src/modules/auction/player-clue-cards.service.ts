import { logger } from '../../core/logger.js';
import { NotFoundError } from '../../core/errors.js';
import { activityRepo } from '../activity/activity.repo.js';
import { playerClueCardsRepo } from './player-clue-cards.repo.js';
import { parsePlayerClueFile } from './player-clue-cards.parser.js';
import type {
  ClueCardDifficulty,
  ClueCardLocale,
  ClueCardStatus,
  CommitResult,
  CommitResultRow,
  PreviewResult,
  PreviewRow,
} from './player-clue-cards.types.js';
import type {
  BulkUpdateStatusRequest,
  ImportCommitRequest,
  ImportPreviewRequest,
  UpdateStatusRequest,
} from './player-clue-cards.schemas.js';

export const playerClueCardsService = {
  async previewImport(params: ImportPreviewRequest): Promise<PreviewResult> {
    const { rows: parsedRows, errors: parseErrors } = parsePlayerClueFile(
      params.text,
      params.defaultDifficulty
    );

    if (parseErrors.length > 0) {
      logger.warn({ parseErrors }, 'player-clue-cards.preview: parse errors');
    }

    const previewRows: PreviewRow[] = [];

    for (const parsed of parsedRows) {
      const matchResult = await playerClueCardsRepo.matchPlayerByName(parsed.answerName);

      previewRows.push({
        ...parsed,
        matchStatus: matchResult.matchStatus,
        matchedPlayer: matchResult.matchedPlayer,
        candidates: matchResult.candidates,
        matchMethod: matchResult.matchMethod,
        matchConfidence: matchResult.matchConfidence,
      });
    }

    const matchedCount = previewRows.filter((r) => r.matchStatus === 'matched').length;
    const ambiguousCount = previewRows.filter((r) => r.matchStatus === 'ambiguous').length;
    const unmatchedCount = previewRows.filter((r) => r.matchStatus === 'unmatched').length;
    const warningCount = previewRows.reduce((sum, r) => sum + r.warnings.length + r.factRiskFlags.length, 0);

    return {
      rowsParsed: previewRows.length,
      matchedCount,
      ambiguousCount,
      unmatchedCount,
      warningCount,
      rows: previewRows,
    };
  },

  async commitImport(params: ImportCommitRequest, adminUserId: string): Promise<CommitResult> {
    const resultRows: CommitResultRow[] = [];
    let inserted = 0;
    let updated = 0;
    let skippedExisting = 0;
    let failed = 0;

    for (const row of params.rows) {
      try {        const difficulty: ClueCardDifficulty = row.difficulty ?? params.defaultDifficulty;
        const difficultySource = row.difficulty ? 'row' : 'default';

        const evidence: Record<string, unknown> = {
          source: 'editor_created',
          style: 'editor_first_person',
          difficulty_source: difficultySource,
          match_confidence: row.matchConfidence ?? null,
          match_method: row.matchMethod ?? null,
          fact_risk_flags: row.factRiskFlags ?? [],
        };

        const sourcePayload: Record<string, unknown> = {
          original_text: row.originalText ?? '',
          answer_name: row.answerName,
          row_index: row.rowIndex,
          source_player_number: row.sourcePlayerNumber ?? null,
          manual_mapping: row.manualMapping,
        };

        const { row: insertedRow, action } = await playerClueCardsRepo.upsertPlayerClueCard({
          footballPlayerId: row.footballPlayerId,
          locale: params.locale as ClueCardLocale,
          clue1: row.clue1,
          clue2: row.clue2,
          clue3: row.clue3,
          difficulty,
          status: params.status as ClueCardStatus,
          source: 'cms',
          generationProvider: 'editor',
          generationModel: 'editor_manual',
          promptVersion: params.promptVersion,
          evidence,
          sourcePayload,
          force: params.force,
        });

        if (action === 'inserted') inserted++;
        else if (action === 'updated') updated++;
        else if (action === 'skipped_existing') skippedExisting++;

        resultRows.push({
          rowIndex: row.rowIndex,
          status: action,
          clueCardId: insertedRow?.id ?? null,
          error: null,
        });
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : 'Unknown error';
        resultRows.push({
          rowIndex: row.rowIndex,
          status: 'failed',
          clueCardId: null,
          error: message,
        });
        logger.error({ error, rowIndex: row.rowIndex }, 'player-clue-cards.commit: row failed');
      }
    }

    await activityRepo.insertAuditLog({
      userId: adminUserId,
      action: 'import',
      entityType: 'player_clue_card',
      metadata: {
        locale: params.locale,
        promptVersion: params.promptVersion,
        status: params.status,
        force: params.force,
        total: params.rows.length,
        inserted,
        updated,
        skippedExisting,
        failed,
      },
    });

    return {
      total: params.rows.length,
      inserted,
      updated,
      skippedExisting,
      failed,
      rows: resultRows,
    };
  },

  async updateStatus(id: string, params: UpdateStatusRequest, adminUserId: string): Promise<void> {
    const existing = await playerClueCardsRepo.getPlayerClueCardById(id);
    if (!existing) {
      throw new NotFoundError('Player clue card not found');
    }

    await playerClueCardsRepo.updatePlayerClueCardStatus(
      id,
      params.status as ClueCardStatus,
      params.reviewNotes ?? null,
      params.rejectionReason ?? null
    );

    await activityRepo.insertAuditLog({
      userId: adminUserId,
      action: 'status_change',
      entityType: 'player_clue_card',
      entityId: id,
      metadata: {
        oldStatus: existing.status,
        newStatus: params.status,
        reviewNotes: params.reviewNotes ?? null,
        rejectionReason: params.rejectionReason ?? null,
      },
    });
  },

  async bulkUpdateStatus(params: BulkUpdateStatusRequest, adminUserId: string): Promise<{ updated: number }> {
    const count = await playerClueCardsRepo.bulkUpdateStatus(
      params.ids,
      params.status as ClueCardStatus,
      params.reviewNotes ?? null
    );

    await activityRepo.insertAuditLog({
      userId: adminUserId,
      action: 'bulk_status_change',
      entityType: 'player_clue_card',
      metadata: {
        ids: params.ids,
        newStatus: params.status,
        reviewNotes: params.reviewNotes ?? null,
        updatedCount: count,
      },
    });

    return { updated: count };
  },
};
