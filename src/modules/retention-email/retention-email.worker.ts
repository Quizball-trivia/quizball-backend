import { config } from '../../core/config.js';
import { emailEnabled, emailUnsubEnabled } from '../../core/email.js';
import { logger } from '../../core/logger.js';
import {
  assignRetentionEmailCandidates,
  deliverRetentionEmails,
} from './retention-email.service.js';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

async function tick(): Promise<void> {
  if (
    !config.RETENTION_EMAIL_EXPERIMENT_ENABLED
    || !config.RESEND_WEBHOOK_SECRET
    || !emailEnabled()
    || !emailUnsubEnabled()
  ) return;
  const assigned = await assignRetentionEmailCandidates();
  const sent = await deliverRetentionEmails();
  if (assigned > 0 || sent > 0) {
    logger.info({ assigned, sent }, 'Retention email experiment tick completed');
  }
}

export function startRetentionEmailWorker(): void {
  if (timer || !config.RETENTION_EMAIL_EXPERIMENT_ENABLED) return;
  logger.info('Retention email experiment worker started');
  const run = () => {
    if (inFlight) return;
    inFlight = tick()
      .catch((error) => logger.error({ error }, 'Retention email experiment tick failed'))
      .finally(() => { inFlight = null; });
  };
  run();
  timer = setInterval(run, TICK_MS);
  timer.unref?.();
}

export async function stopRetentionEmailWorker(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await inFlight;
}
