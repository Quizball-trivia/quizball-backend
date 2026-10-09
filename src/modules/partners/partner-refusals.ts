/** PostHog event for a partner request we refused or failed, so an alert can reach us
 *  (docs/FREECROCO-POSTHOG-DASHBOARD.md). Callers send it only when the request can be tied to the partner (an
 *  allowlisted address, a known key, a signed-in player) or the failure is ours: these URLs are public, and
 *  strangers probing them must neither page us nor fill PostHog. Sending never fails or delays the request. */

import type { Request, Response } from 'express';
import { trackEvent } from '../../core/analytics.js';
import { logger } from '../../core/logger.js';
import { resolveTrustedClientIp } from '../../http/client-ip.js';
import { getFreecrocoConfig, type PartnerConfig } from './partner-config.js';
import { ipAllowed, matchApiKey } from './partner-credentials.js';

export interface PartnerRefusal {
  slug: string;
  environment: string;
  /** The error code we answered with (`ip_not_allowed`, `unknown_key`, `invalid_request`, `internal_error`, …). */
  reason: string;
  status: number;
  /** `machine` = the partner's server, `player` = a signed-in player's browser. */
  caller: 'machine' | 'player' | 'unknown';
  /** users.id of the signed-in player, when there is one. */
  userId?: string;
  route?: string;
  field?: string;
  issue?: string;
  contentType?: string;
}

type Caller = Pick<PartnerRefusal, 'slug' | 'environment' | 'caller' | 'userId'>;

/** A partner server retrying a broken call in a loop is one problem, not thousands of events. Per process, over any
 *  60 seconds, on the monotonic clock. */
export const REFUSAL_EVENTS_PER_MINUTE = 10;
const sentAt: number[] = [];
let droppedSinceLastSent = 0;

export function resetPartnerRefusalLimit(): void {
  sentAt.length = 0;
  droppedSinceLastSent = 0;
}

/** Runs `send` once the response has gone out (or its connection closed): reporting must not add work, or a
 *  difference in timing, to the answer. */
function afterResponse(res: Response | undefined, send: () => void): void {
  if (!res || res.writableFinished || res.destroyed) {
    setImmediate(send);
    return;
  }
  let sent = false;
  const once = () => {
    if (sent) return;
    sent = true;
    send();
  };
  res.once('finish', once);
  res.once('close', once);
}

export function trackPartnerRefusal(refusal: PartnerRefusal, res?: Response, now: number = performance.now()): void {
  while (sentAt.length > 0 && now - sentAt[0] >= 60_000) sentAt.shift();
  if (sentAt.length >= REFUSAL_EVENTS_PER_MINUTE) {
    droppedSinceLastSent += 1;
    return;
  }
  sentAt.push(now);
  const { slug, environment, userId, ...properties } = refusal;
  const dropped = droppedSinceLastSent;
  droppedSinceLastSent = 0;
  afterResponse(res, () => {
    try {
      trackEvent('partner_request_refused', userId ?? `partner:${slug}:${environment}`, {
        ...properties,
        partner_slug: slug,
        partner_environment: environment,
        ...(dropped > 0 ? { dropped_before: dropped } : {}),
      });
    } catch (error) {
      logger.warn({ err: error }, 'Partner refusal event not sent');
    }
  });
}

function deployConfig(): PartnerConfig | null {
  try {
    return getFreecrocoConfig();
  } catch {
    return null;
  }
}

/** The partner admin API is our own staff's; its failures are not the partner integration's. Express matches paths
 *  without regard to case, so this does too. */
const isAdminRequest = (req: Request): boolean => /^\/partner-admin(\/|$|\?)/i.test(req.originalUrl);

/** Who a request belongs to: the principal a partner auth step attached, or — for a request refused before one ran
 *  (an unreadable body) — the partner's server when its address or key checks out. Null for anyone else. */
export function partnerCaller(req: Request): Caller | null {
  if (isAdminRequest(req)) return null;
  if (req.partnerMachine) {
    return { slug: req.partnerMachine.config.slug, environment: req.partnerMachine.config.environment, caller: 'machine' };
  }
  if (req.partner) return { slug: req.partner.slug, environment: req.partner.environment, caller: 'player', userId: req.partner.userId };
  const config = deployConfig();
  if (config && (ipAllowed(config, resolveTrustedClientIp(req)) || matchApiKey(config, req.headers['x-api-key']))) {
    return { slug: config.slug, environment: config.environment, caller: 'machine' };
  }
  return null;
}

/** For our own failures on a request nobody signed: the deploy's partner, if it has one configured. */
export function deployPartner(req: Request): Caller | null {
  if (isAdminRequest(req)) return null;
  const config = deployConfig();
  return config ? { slug: config.slug, environment: config.environment, caller: 'unknown' } : null;
}

export function routePattern(req: Request): string | undefined {
  const path: unknown = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? path : undefined;
}
