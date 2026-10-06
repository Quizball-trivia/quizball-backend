import { logger } from '../../../../core/logger.js';
import { sweepQuizBoards } from './quiz-board.service.js';

/** Ends boards whose player went away (pick idle, unanswered questions) and boards whose play a block cancelled.
 *  SKIP LOCKED keeps replicas and live requests from fighting over a board. */
const SWEEP_INTERVAL_MS = 10_000;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

export function startQuizBoardSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = sweepQuizBoards()
      .then((finished) => {
        if (finished > 0) logger.info({ finished }, 'partner quiz-board sweep finished abandoned boards');
      })
      .catch((error) => logger.error({ error }, 'partner quiz-board sweep failed'))
      .finally(() => {
        inFlight = null;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

export async function stopQuizBoardSweeper(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await inFlight;
}
