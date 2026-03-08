import { activityRepo } from './activity.repo.js';
import type { AuditLogInsert } from './activity.types.js';
import { logger } from '../../core/logger.js';

/**
 * Fire-and-forget audit logger.
 * Errors are logged but never thrown — audit logging must never break business flows.
 */
export function logAudit(params: AuditLogInsert): void {
  void activityRepo.insertAuditLog(params).catch((error) => {
    logger.error(
      {
        error,
        audit: {
          userId: params.userId,
          action: params.action,
          entityType: params.entityType,
          entityId: params.entityId ?? null,
          hasMetadata: params.metadata != null,
        },
      },
      'Failed to write audit log'
    );
  });
}
