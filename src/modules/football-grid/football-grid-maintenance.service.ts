import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';

const INTERVAL_MS = 24 * 60 * 60 * 1_000;
let timer: NodeJS.Timeout | null = null;

async function run(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `DELETE FROM football_grid_missing_answer_reports
        WHERE status IN ('accepted','rejected','duplicate','closed')
          AND reviewed_at < now() - interval '365 days'`,
    );
    await tx.unsafe(
      `DELETE FROM football_grid_command_inbox i
        WHERE i.completed_at < now() - interval '90 days'
          AND NOT EXISTS (
            SELECT 1 FROM football_grid_attempts a
            JOIN football_grid_missing_answer_reports r ON r.attempt_id = a.id
             WHERE a.inbox_id = i.id
          )`,
    );
  });
}

export const footballGridMaintenanceService = {
  start(): void {
    if (timer) return;
    timer = setInterval(() => void run().catch((error) => {
      logger.warn({ error }, 'Football Grid retention maintenance failed');
    }), INTERVAL_MS);
    timer.unref?.();
  },
  run,
};
