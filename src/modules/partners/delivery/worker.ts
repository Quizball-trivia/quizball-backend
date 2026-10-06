import { sql } from '../../../db/index.js';
import { ZodError } from 'zod';
import { logger } from '../../../core/logger.js';
import { getFreecrocoConfig } from '../partner-config.js';
import { trackScoreDeliveryOutcome } from '../partner-analytics.js';
import { ScoreEventDispatcher, type DeliveryDestination } from './dispatcher.js';

let dispatcher: ScoreEventDispatcher | null = null;

/** What may be logged about an invalid config: the zod paths and issue codes, or that it is not JSON. */
export function safeConfigIssues(error: unknown): Array<{ path: string; code: string }> {
  if (!(error instanceof ZodError)) return [{ path: '', code: error instanceof SyntaxError ? 'invalid_json' : 'unreadable' }];
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map((p) => (typeof p === 'number' ? String(p) : p.replace(/[^A-Za-z0-9_]/g, '?'))).join('.'),
    code: issue.code,
  }));
}

/** The deploy's Freecroco score-events destination; null until Freecroco gives us the URL and key. */
export function freecrocoDestination(): DeliveryDestination | null {
  const config = getFreecrocoConfig();
  if (!config?.webhook) return null;
  return { slug: config.slug, environment: config.environment, url: config.webhook.url, apiKey: config.webhook.apiKey };
}

/** Every replica runs one. Idle (events wait as pending) while the partner or its webhook is not configured. */
export function startPartnerDeliveryWorker(): void {
  if (dispatcher) return;
  let destination: DeliveryDestination | null;
  try {
    destination = freecrocoDestination();
  } catch (error) {
    // Never the parser's message or stack: they quote the input, keys included.
    logger.error(
      { code: 'partner_config_invalid', issues: safeConfigIssues(error) },
      'PARTNER_FREECROCO_CONFIG is invalid; partner score delivery stays idle',
    );
    return;
  }
  if (!destination) return;
  dispatcher = new ScoreEventDispatcher({
    sql,
    destination: () => destination,
    log: logger,
    onFinal: (outcome) => {
      trackScoreDeliveryOutcome(outcome).catch((error) => {
        logger.warn({ err: error, eventId: outcome.eventId }, 'Partner score delivery analytics failed');
      });
    },
  });
  dispatcher.start();
  logger.info({ partner: destination.slug, environment: destination.environment }, 'Partner score delivery started');
}

/** Call after a commit that queued or resent events, so they go out without waiting for the next poll. */
export function wakePartnerDelivery(): void {
  dispatcher?.wake();
}

export async function stopPartnerDeliveryWorker(): Promise<void> {
  const current = dispatcher;
  dispatcher = null;
  await current?.close(5_000);
}
