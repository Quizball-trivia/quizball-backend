import { activityRepo } from './activity.repo.js';
import type { AuditLogInsert } from './activity.types.js';
import { logger } from '../../core/logger.js';

/**
 * Fire-and-forget audit logger.
 * Errors are logged but never thrown — audit logging must never break business flows.
 */
export async function logAudit(params: AuditLogInsert): Promise<void> {
  try {
    await activityRepo.insertAuditLog(params);
  } catch (error) {
    logger.error({ error, audit: params }, 'Failed to write audit log');
  }
}
