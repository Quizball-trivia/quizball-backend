import { config } from '../../core/config.js';
import { emailEnabled, emailUnsubEnabled } from '../../core/email.js';
import { logger } from '../../core/logger.js';
import {
  assignDormantComebackEmailCandidates,
  assignRetentionEmailCandidates,
  deliverRetentionEmails,
} from './retention-email.service.js';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

async function tick(): Promise<void> {
  if (
    (!config.RETENTION_EMAIL_EXPERIMENT_ENABLED
      && !config.DORMANT_COMEBACK_EMAIL_EXPERIMENT_ENABLED)
    || !config.RESEND_WEBHOOK_SECRET
    || !emailEnabled()
    || !emailUnsubEnabled()
  ) return;
  const weekendLeagueAssigned = await assignRetentionEmailCandidates();
  const dormantAssigned = await assignDormantComebackEmailCandidates();
  const sent = await deliverRetentionEmails();
  if (weekendLeagueAssigned > 0 || dormantAssigned > 0 || sent > 0) {
    logger.info(
      { weekendLeagueAssigned, dormantAssigned, sent },
      'Retention email experiments tick completed',
    );
  }
}

export function startRetentionEmailWorker(): void {
  if (
    timer
    || (!config.RETENTION_EMAIL_EXPERIMENT_ENABLED
      && !config.DORMANT_COMEBACK_EMAIL_EXPERIMENT_ENABLED)
  ) return;
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
