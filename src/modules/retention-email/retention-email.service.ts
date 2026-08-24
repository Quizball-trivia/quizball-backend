import {
  getPostHogClient,
  stableAnalyticsEventUuid,
  trackEvent,
} from '../../core/analytics.js';
import { config } from '../../core/config.js';
import {
  emailLinkToken,
  emailUnsubEnabled,
  marketingEmailHeaders,
  sendEmailDetailed,
  verifyEmailLinkToken,
} from '../../core/email.js';
import { logger } from '../../core/logger.js';
import {
  retentionEmailRepo,
  type RetentionEmailAssignment,
  type RetentionEmailCandidate,
  type RetentionEmailVariant,
} from './retention-email.repo.js';

export const RETENTION_EMAIL_CAMPAIGN_KEY = 'weekend_league_comeback_v1';
export const RETENTION_EMAIL_FEATURE_FLAG_KEY = 'email-comeback-weekend-league';
const MAX_ATTEMPTS = 5;
const STALE_CLAIM_MINUTES = 10;
const PUBLIC_API_FALLBACK = 'https://quizball-backend-production.up.railway.app';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function linkPayload(assignment: Pick<RetentionEmailAssignment, 'id' | 'user_id' | 'destination_path'>) {
  return `${assignment.id}:${assignment.user_id}:${assignment.destination_path}`;
}

function unsubscribePayload(assignmentId: string, userId: string): string {
  return `${assignmentId}:${userId}`;
}

function apiOrigin(): string {
  return (config.API_BASE_URL ?? PUBLIC_API_FALLBACK).replace(/\/+$/, '');
}

export function retentionEmailClickUrl(assignment: RetentionEmailAssignment): string | null {
  const token = emailLinkToken('retention-click', linkPayload(assignment));
  if (!token) return null;
  return `${apiOrigin()}/api/v1/email/retention/click?a=${encodeURIComponent(assignment.id)}&t=${token}`;
}

export function retentionEmailUnsubscribeUrl(assignmentId: string, userId: string): string | null {
  const token = emailLinkToken(
    'retention-unsubscribe',
    unsubscribePayload(assignmentId, userId),
  );
  if (!token) return null;
  return `${apiOrigin()}/api/v1/email/unsubscribe?u=${encodeURIComponent(userId)}&a=${encodeURIComponent(assignmentId)}&t=${token}`;
}

export function verifyRetentionUnsubscribeToken(
  assignmentId: string,
  userId: string,
  token: string,
): boolean {
  return verifyEmailLinkToken(
    'retention-unsubscribe',
    unsubscribePayload(assignmentId, userId),
    token,
  );
}

function humanTimeLeft(entryClosesAt: string, now = new Date()): string {
  const remainingHours = Math.max(
    1,
    Math.ceil((Date.parse(entryClosesAt) - now.getTime()) / (60 * 60 * 1_000)),
  );
  return remainingHours >= 24
    ? `${Math.ceil(remainingHours / 24)}d`
    : `${remainingHours}h`;
}

export function buildRetentionEmail(
  assignment: RetentionEmailAssignment,
  clickUrl: string,
  unsubscribeUrl: string,
  now = new Date(),
): { subject: string; html: string } {
  const georgian = assignment.preferred_language.toLowerCase().startsWith('ka');
  const timeLeft = humanTimeLeft(assignment.entry_closes_at, now);
  const nickname = assignment.nickname?.trim()
    ? escapeHtml(assignment.nickname.trim())
    : null;
  const greeting = georgian
    ? (nickname ? `გამარჯობა, ${nickname}` : 'გამარჯობა')
    : (nickname ? `Hi ${nickname}` : 'Hi');
  const subject = georgian
    ? `უიქენდის ლიგამდე ${timeLeft} დარჩა`
    : `Weekend League closes in ${timeLeft}`;
  const title = georgian ? 'უიქენდის ლიგა გელოდება' : 'Weekend League is waiting';
  const body = assignment.cta_state === 'qualified'
    ? (georgian
        ? 'საკმარისი QP უკვე გაქვს. შედი უიქენდის ლიგაში, სანამ რეგისტრაცია დაიხურება.'
        : 'You already have enough QP. Enter Weekend League before registration closes.')
    : (georgian
        ? `შესასვლელად დაგრჩა მხოლოდ ${assignment.qp_remaining} QP. ითამაშე Ranked და მოასწარი კვალიფიკაცია.`
        : `You only need ${assignment.qp_remaining} more QP. Play Ranked and qualify before entry closes.`);
  const cta = assignment.cta_state === 'qualified'
    ? (georgian ? 'შედი ლიგაში' : 'Enter Weekend League')
    : (georgian ? 'ითამაშე Ranked' : 'Play Ranked');
  const unsubscribe = georgian ? 'გამოწერის გაუქმება' : 'Unsubscribe';

  return {
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111">
        <div style="font-size:28px;margin-bottom:8px">🔥</div>
        <p style="margin:0 0 8px;color:#555">${greeting}</p>
        <h2 style="margin:0 0 10px">${title}</h2>
        <p style="margin:0 0 20px;line-height:1.55;color:#444">${body}</p>
        <a href="${clickUrl}"
           style="display:inline-block;background:#38b60e;color:white;padding:13px 24px;border-radius:10px;text-decoration:none;font-weight:700">
          ${cta}
        </a>
        <p style="margin:20px 0 0;font-size:12px"><a href="${unsubscribeUrl}" style="color:#999">${unsubscribe}</a></p>
      </div>`,
  };
}

function assignmentAnalyticsProperties(assignment: RetentionEmailAssignment) {
  return {
    campaign_key: assignment.campaign_key,
    variant: assignment.variant,
    tournament_id: assignment.tournament_id,
    cta_state: assignment.cta_state,
    destination: assignment.destination_path,
    qp_remaining: assignment.qp_remaining,
  };
}

async function evaluateVariant(candidate: RetentionEmailCandidate): Promise<RetentionEmailVariant | null> {
  const client = getPostHogClient();
  if (!client) return null;
  try {
    const value = await client.getFeatureFlag(
      RETENTION_EMAIL_FEATURE_FLAG_KEY,
      candidate.user_id,
      {
        personProperties: { country: 'GE' },
        sendFeatureFlagEvents: false,
      },
    );
    return value === 'control' || value === 'test' ? value : null;
  } catch (error) {
    logger.warn({ error }, 'Retention email feature flag evaluation failed');
    return null;
  }
}

export async function assignRetentionEmailCandidates(): Promise<number> {
  if (
    !config.RETENTION_EMAIL_EXPERIMENT_ENABLED
    || !config.RESEND_WEBHOOK_SECRET
    || !emailUnsubEnabled()
    || config.RETENTION_EMAIL_ASSIGNMENT_CAP <= 0
  ) return 0;
  const candidates = await retentionEmailRepo.listEligibleCandidates({
    campaignKey: RETENTION_EMAIL_CAMPAIGN_KEY,
    minInactiveDays: config.RETENTION_EMAIL_MIN_INACTIVE_DAYS,
    maxInactiveDays: config.RETENTION_EMAIL_MAX_INACTIVE_DAYS,
    frequencyDays: config.RETENTION_EMAIL_FREQUENCY_DAYS,
    minLeadHours: config.RETENTION_EMAIL_MIN_LEAD_HOURS,
    maxLeadHours: config.RETENTION_EMAIL_MAX_LEAD_HOURS,
    userIdAllowlist: config.RETENTION_EMAIL_USER_ID_ALLOWLIST,
    limit: Math.min(
      config.RETENTION_EMAIL_BATCH_SIZE,
      config.RETENTION_EMAIL_ASSIGNMENT_CAP,
    ),
  });

  let assigned = 0;
  for (const candidate of candidates) {
    const variant = await evaluateVariant(candidate);
    if (!variant) continue;
    const assignment = await retentionEmailRepo.insertAssignment({
      campaignKey: RETENTION_EMAIL_CAMPAIGN_KEY,
      featureFlagKey: RETENTION_EMAIL_FEATURE_FLAG_KEY,
      candidate,
      variant,
      assignmentCap: config.RETENTION_EMAIL_ASSIGNMENT_CAP,
    });
    if (!assignment) continue;
    assigned += 1;
    const properties = assignmentAnalyticsProperties(assignment);
    trackEvent('$feature_flag_called', assignment.user_id, {
      $feature_flag: RETENTION_EMAIL_FEATURE_FLAG_KEY,
      $feature_flag_response: variant,
      ...properties,
    }, {
      uuid: stableAnalyticsEventUuid(`retention-email:exposure:${assignment.id}`),
      occurredAt: assignment.assigned_at,
    });
    trackEvent('retention_email_assigned', assignment.user_id, properties, {
      uuid: stableAnalyticsEventUuid(`retention-email:assigned:${assignment.id}`),
      occurredAt: assignment.assigned_at,
    });
  }
  return assigned;
}

export async function deliverRetentionEmails(): Promise<number> {
  if (
    !config.RETENTION_EMAIL_EXPERIMENT_ENABLED
    || !config.RESEND_WEBHOOK_SECRET
    || !emailUnsubEnabled()
  ) return 0;
  await retentionEmailRepo.recoverStaleClaims(MAX_ATTEMPTS, STALE_CLAIM_MINUTES);
  await retentionEmailRepo.cancelInvalidPending();

  let sent = 0;
  for (let count = 0; count < config.RETENTION_EMAIL_BATCH_SIZE; count += 1) {
    const assignment = await retentionEmailRepo.claimOne(MAX_ATTEMPTS);
    if (!assignment) break;
    const clickUrl = retentionEmailClickUrl(assignment);
    const unsubUrl = retentionEmailUnsubscribeUrl(assignment.id, assignment.user_id);
    if (!clickUrl || !unsubUrl) {
      await retentionEmailRepo.markDelivery({
        assignmentId: assignment.id,
        accepted: false,
        providerMessageId: null,
        maxAttempts: MAX_ATTEMPTS,
      });
      continue;
    }
    const content = buildRetentionEmail(assignment, clickUrl, unsubUrl);
    const delivery = await sendEmailDetailed({
      to: assignment.email,
      subject: content.subject,
      html: content.html,
      idempotencyKey: `retention-email:${assignment.id}`,
      headers: {
        ...marketingEmailHeaders(assignment.user_id),
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    await retentionEmailRepo.markDelivery({
      assignmentId: assignment.id,
      accepted: delivery.accepted,
      providerMessageId: delivery.messageId,
      maxAttempts: MAX_ATTEMPTS,
    });
    const event = delivery.accepted
      ? 'retention_email_sent'
      : 'retention_email_delivery_failed';
    trackEvent(event, assignment.user_id, {
      ...assignmentAnalyticsProperties(assignment),
      attempt: assignment.attempts,
    }, {
      uuid: stableAnalyticsEventUuid(`retention-email:${event}:${assignment.id}:${assignment.attempts}`),
      occurredAt: new Date(),
    });
    if (delivery.accepted) sent += 1;
  }
  return sent;
}

export async function handleRetentionEmailClick(
  assignmentId: string,
  token: string,
): Promise<string | null> {
  const assignment = await retentionEmailRepo.getClickAssignment(assignmentId);
  if (!assignment || assignment.variant !== 'test' || assignment.send_status !== 'sent') {
    return null;
  }
  if (!verifyEmailLinkToken('retention-click', linkPayload(assignment), token)) {
    return null;
  }
  const click = await retentionEmailRepo.markClicked(assignmentId);
  if (!click) return null;
  if (click.first_click) {
    trackEvent('retention_email_clicked', assignment.user_id, {
      campaign_key: assignment.campaign_key,
      variant: assignment.variant,
      cta_state: assignment.cta_state,
      destination: assignment.destination_path,
    }, {
      uuid: stableAnalyticsEventUuid(`retention-email:clicked:${assignment.id}`),
      occurredAt: click.clicked_at,
    });
  }
  const destination = new URL(assignment.destination_path, config.PUBLIC_SITE_ORIGIN);
  destination.searchParams.set('utm_source', 'retention_email');
  destination.searchParams.set('utm_medium', 'email');
  destination.searchParams.set('utm_campaign', assignment.campaign_key);
  destination.searchParams.set('utm_content', assignment.cta_state);
  destination.searchParams.set('retention_assignment', assignment.id);
  return destination.toString();
}

export async function markRetentionEmailUnsubscribed(
  assignmentId: string,
  userId: string,
): Promise<void> {
  const attribution = await retentionEmailRepo.markUnsubscribed({ assignmentId, userId });
  if (!attribution) return;
  trackEvent('retention_email_unsubscribed', userId, {
    campaign_key: attribution.campaign_key,
    variant: attribution.variant,
  }, {
    uuid: stableAnalyticsEventUuid(`retention-email:unsubscribed:${assignmentId}`),
    occurredAt: new Date(),
  });
}

export type RetentionEmailProviderEventType =
  | 'email.delivered'
  | 'email.delivery_delayed'
  | 'email.bounced'
  | 'email.failed'
  | 'email.suppressed'
  | 'email.complained'
  | 'email.opened';

export async function handleRetentionEmailProviderEvent(input: {
  eventId: string;
  eventType: RetentionEmailProviderEventType;
  providerMessageId: string;
  occurredAt: string;
}): Promise<void> {
  const assignment = await retentionEmailRepo.applyProviderEvent(input);
  if (!assignment) return;
  const status = input.eventType.replace('email.', '');
  const properties = {
    campaign_key: assignment.campaign_key,
    variant: assignment.variant,
    cta_state: assignment.cta_state,
    destination: assignment.destination_path,
    provider_status: status,
  };
  const eventName = input.eventType === 'email.opened'
    ? 'retention_email_opened'
    : input.eventType === 'email.delivered'
    ? 'retention_email_delivered'
    : input.eventType === 'email.delivery_delayed'
      ? 'retention_email_delivery_delayed'
      : input.eventType === 'email.complained'
        ? 'retention_email_complained'
        : 'retention_email_delivery_failed';
  trackEvent(eventName, assignment.user_id, properties, {
    uuid: stableAnalyticsEventUuid(`retention-email:provider:${input.eventId}`),
    occurredAt: input.occurredAt,
  });
}
