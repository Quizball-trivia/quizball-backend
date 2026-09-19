import { config } from '../../core/config.js';
import { emailEnabled, emailUnsubEnabled } from '../../core/email.js';
import { logger } from '../../core/logger.js';
import {
  assignDormantComebackEmailCandidates,
  assignRetentionEmailCandidates,
  deliverRetentionEmails,
} from './retention-email.service.js';
import {
  assignReactivationJourneyCandidates,
  scheduleReactivationJourneySteps,
} from './retention-journey.service.js';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

async function tick(): Promise<void> {
  if (
    (!config.RETENTION_EMAIL_EXPERIMENT_ENABLED
      && !config.DORMANT_COMEBACK_EMAIL_EXPERIMENT_ENABLED
      && !config.REACTIVATION_JOURNEY_ENABLED)
    || !config.RESEND_WEBHOOK_SECRET
    || !emailEnabled()
    || !emailUnsubEnabled()
  ) return;
  // These three assignment passes are independent — different campaigns,
  // different tables, each gated by its own cap — so they were paying three
  // sequential round trips for no ordering guarantee. Delivery still runs after
  // them, since it sends what they just assigned.
  // allSettled, not all: `all` rejects on the first failure while the other two
  // passes are still in flight, so `inFlight` would clear and the next tick
  // could start them again concurrently — something the old sequential version
  // could not do. Each pass reports its own outcome instead.
  const [weekendLeague, dormant, journeyAssignment] = await Promise.allSettled([
    assignRetentionEmailCandidates(),
    assignDormantComebackEmailCandidates(),
    assignReactivationJourneyCandidates(),
  ]);
  for (const [name, outcome] of [
    ['weekendLeague', weekendLeague],
    ['dormant', dormant],
    ['journey', journeyAssignment],
  ] as const) {
    if (outcome.status === 'rejected') {
      logger.error({ error: outcome.reason, pass: name }, 'Retention assignment pass failed');
    }
  }
  const weekendLeagueAssigned = weekendLeague.status === 'fulfilled' ? weekendLeague.value : 0;
  const dormantAssigned = dormant.status === 'fulfilled' ? dormant.value : 0;
  const journeyAssigned = journeyAssignment.status === 'fulfilled' ? journeyAssignment.value : 0;
  const journey = await scheduleReactivationJourneySteps();
  const sent = await deliverRetentionEmails();
  if (
    weekendLeagueAssigned > 0
    || dormantAssigned > 0
    || journeyAssigned > 0
    || journey.exited > 0
    || journey.scheduled > 0
    || sent > 0
  ) {
    logger.info(
      { weekendLeagueAssigned, dormantAssigned, journeyAssigned, ...journey, sent },
      'Retention email experiments tick completed',
    );
  }
}

export function startRetentionEmailWorker(): void {
  if (
    timer
    || (!config.RETENTION_EMAIL_EXPERIMENT_ENABLED
      && !config.DORMANT_COMEBACK_EMAIL_EXPERIMENT_ENABLED
      && !config.REACTIVATION_JOURNEY_ENABLED)
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
