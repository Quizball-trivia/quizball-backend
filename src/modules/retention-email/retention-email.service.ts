import { stableAnalyticsEventUuid, trackEvent } from '../../core/analytics.js';
import { config } from '../../core/config.js';
import {
  emailLinkToken,
  emailUnsubEnabled,
  marketingEmailHeaders,
  sendEmailDetailed,
  verifyEmailLinkToken,
} from '../../core/email.js';
import {
  retentionEmailRepo,
  type RetentionEmailAssignment,
} from './retention-email.repo.js';
import { RETENTION_FLAG_EXCLUSION_TTL_DAYS } from './retention-flag-exclusions.repo.js';
import { resolveRetentionVariant } from './retention-flag.js';

export const RETENTION_EMAIL_CAMPAIGN_KEY = 'weekend_league_comeback_v1';
export const RETENTION_EMAIL_FEATURE_FLAG_KEY = 'email-comeback-weekend-league';
export const DORMANT_COMEBACK_EMAIL_CAMPAIGN_KEY = 'dormant_player_comeback_v1';
export const DORMANT_COMEBACK_EMAIL_FEATURE_FLAG_KEY = 'email-comeback-dormant-players';
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
  const georgian = retentionEmailLanguage(assignment) === 'ka';
  const nickname = assignment.nickname?.trim()
    ? escapeHtml(assignment.nickname.trim())
    : null;
  const greeting = georgian
    ? (nickname ? `გამარჯობა, ${nickname}` : 'გამარჯობა')
    : (nickname ? `Hi ${nickname}` : 'Hi');

  if (assignment.message_kind === 'dormant_journey') {
    const milestone = assignment.milestone_days;
    if (!milestone) throw new Error('Dormant journey email requires a milestone');
    const copy = georgian
      ? {
          3: {
            subject: 'დღევანდელი Quizball ჩელენჯი გელოდება',
            title: 'ერთი სწრაფი ჩელენჯი?',
            body: 'დაბრუნდი დღევანდელ ჩელენჯზე და შეამოწმე, რამდენ ქულას აიღებ.',
            cta: 'ითამაშე Daily Challenge',
          },
          7: {
            subject: 'უიქენდის ლიგა Quizball-ში',
            title: 'შენი შემდეგი შეჯიბრი მზადაა',
            body: 'ნახე უიქენდის ლიგის მიმდინარე სტატუსი, ითამაშე Ranked და დააგროვე საჭირო QP.',
            cta: 'ნახე Weekend League',
          },
          14: {
            subject: 'Auction რეჟიმი უკვე Quizball-შია',
            title: 'სცადე ახალი Auction მატჩი',
            body: 'ააწყვე შემადგენლობა აუქციონზე და შეეჯიბრე სხვა მოთამაშეებს ახალ რეჟიმში.',
            cta: 'ითამაშე Auction',
          },
          30: {
            subject: 'Quizball-ში ბევრი რამ შეიცვალა',
            title: 'ნახე, რა დაგხვდება დაბრუნებისას',
            body: 'Weekend League, Auction, Daily Challenge და ახალი მატჩები — აირჩიე რეჟიმი და დაიწყე ერთი თამაში.',
            cta: 'დაბრუნდი Quizball-ში',
          },
          60: {
            subject: 'ერთი მატჩისთვის მზად ხარ?',
            title: 'Quizball-ს შენი დაბრუნება უნდა',
            body: 'შენი ანგარიში ისევ მზადაა. შემოდი, აირჩიე სასურველი რეჟიმი და ითამაშე ერთი მატჩი.',
            cta: 'ითამაშე ახლა',
          },
        }[milestone]
      : {
          3: {
            subject: "Today's Quizball challenge is waiting",
            title: 'Up for one quick challenge?',
            body: "Come back for today's challenge and see how high you can score.",
            cta: 'Play Daily Challenge',
          },
          7: {
            subject: 'Weekend League is on Quizball',
            title: 'Your next competition is ready',
            body: 'Check the current Weekend League, play Ranked and earn the QP you need.',
            cta: 'View Weekend League',
          },
          14: {
            subject: 'Auction mode is now on Quizball',
            title: 'Try a new Auction match',
            body: 'Build your squad through the auction and compete with other players in a new mode.',
            cta: 'Play Auction',
          },
          30: {
            subject: 'A lot has changed in Quizball',
            title: "See what's waiting for you",
            body: 'Weekend League, Auction, Daily Challenge and new matches — choose a mode and play one game.',
            cta: 'Return to Quizball',
          },
          60: {
            subject: 'Ready for one match?',
            title: 'Quizball would love to have you back',
            body: 'Your account is ready. Come back, choose a mode and play one match.',
            cta: 'Play now',
          },
        }[milestone];
    const unsubscribe = georgian ? 'გამოწერის გაუქმება' : 'Unsubscribe';
    return {
      subject: copy.subject,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111">
          <div style="font-size:28px;margin-bottom:8px">⚽</div>
          <p style="margin:0 0 8px;color:#555">${greeting}</p>
          <h2 style="margin:0 0 10px">${copy.title}</h2>
          <p style="margin:0 0 20px;line-height:1.55;color:#444">${copy.body}</p>
          <a href="${clickUrl}"
             style="display:inline-block;background:#2455ff;color:white;padding:13px 24px;border-radius:10px;text-decoration:none;font-weight:700">
            ${copy.cta}
          </a>
          <p style="margin:20px 0 0;font-size:12px"><a href="${unsubscribeUrl}" style="color:#999">${unsubscribe}</a></p>
        </div>`,
    };
  }

  if (assignment.message_kind === 'dormant_comeback') {
    const subject = georgian
      ? 'Quizball-ში ახალი მატჩი გელოდება'
      : 'A new Quizball match is waiting';
    const title = georgian ? 'დაბრუნდი თამაშში' : 'Come back to the game';
    const body = georgian
      ? 'ცოტა ხანია არ გითამაშია. დაბრუნდი Quizball-ში და ითამაშე ერთი მატჩი დღეს.'
      : 'It has been a while since your last match. Come back to Quizball and play one today.';
    const cta = georgian ? 'ითამაშე ახლა' : 'Play now';
    const unsubscribe = georgian ? 'გამოწერის გაუქმება' : 'Unsubscribe';
    return {
      subject,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111">
          <div style="font-size:28px;margin-bottom:8px">⚽</div>
          <p style="margin:0 0 8px;color:#555">${greeting}</p>
          <h2 style="margin:0 0 10px">${title}</h2>
          <p style="margin:0 0 20px;line-height:1.55;color:#444">${body}</p>
          <a href="${clickUrl}"
             style="display:inline-block;background:#2455ff;color:white;padding:13px 24px;border-radius:10px;text-decoration:none;font-weight:700">
            ${cta}
          </a>
          <p style="margin:20px 0 0;font-size:12px"><a href="${unsubscribeUrl}" style="color:#999">${unsubscribe}</a></p>
        </div>`,
    };
  }

  if (!assignment.entry_closes_at) {
    throw new Error('Weekend League retention email requires entry_closes_at');
  }
  const timeLeft = humanTimeLeft(assignment.entry_closes_at, now);
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

function retentionEmailLanguage(assignment: RetentionEmailAssignment): 'ka' | 'en' {
  if (assignment.message_kind === 'dormant_journey') {
    return assignment.country?.trim().toUpperCase() === 'GE' ? 'ka' : 'en';
  }
  return assignment.preferred_language.toLowerCase().startsWith('ka') ? 'ka' : 'en';
}

function assignmentAnalyticsProperties(assignment: RetentionEmailAssignment) {
  const inactivityDays = Math.max(0, Math.floor(
    (Date.parse(assignment.assigned_at) - Date.parse(assignment.last_match_started_at))
    / (24 * 60 * 60 * 1_000),
  ));
  const countryCode = assignment.country?.trim().toUpperCase() || 'UNKNOWN';
  return {
    campaign_key: assignment.campaign_key,
    variant: assignment.variant,
    message_kind: assignment.message_kind,
    tournament_id: assignment.tournament_id,
    cta_state: assignment.cta_state,
    destination: assignment.destination_path,
    qp_remaining: assignment.qp_remaining,
    lifetime_matches: assignment.lifetime_matches,
    inactivity_days: inactivityDays,
    journey_enrollment_id: assignment.journey_enrollment_id ?? null,
    milestone_days: assignment.milestone_days ?? null,
    country_code: countryCode,
    content_language: retentionEmailLanguage(assignment),
  };
}

export async function assignRetentionEmailCandidates(): Promise<number> {
  if (
    !config.RETENTION_EMAIL_EXPERIMENT_ENABLED
    || !config.RESEND_WEBHOOK_SECRET
    || !emailUnsubEnabled()
    || config.RETENTION_EMAIL_ASSIGNMENT_CAP <= 0
  ) return 0;
  // Skip the candidate scan once the campaign cap is spent — it is the second
  // most expensive statement on prod (318.3 ms mean) and the cap is reached.
  if (!(await retentionEmailRepo.hasCampaignCapacity(
    RETENTION_EMAIL_CAMPAIGN_KEY,
    config.RETENTION_EMAIL_ASSIGNMENT_CAP,
  ))) return 0;
  const candidates = await retentionEmailRepo.listEligibleCandidates({
    campaignKey: RETENTION_EMAIL_CAMPAIGN_KEY,
    featureFlagKey: RETENTION_EMAIL_FEATURE_FLAG_KEY,
    // Never longer than the inactivity this campaign requires, so an exclusion
    // cannot outlive the dormancy episode it was recorded in.
    exclusionTtlDays: Math.min(RETENTION_FLAG_EXCLUSION_TTL_DAYS, config.RETENTION_EMAIL_MIN_INACTIVE_DAYS),
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
    const variant = await resolveRetentionVariant({
      featureFlagKey: RETENTION_EMAIL_FEATURE_FLAG_KEY,
      userId: candidate.user_id,
      country: candidate.country,
      logContext: 'Retention email',
    });
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

export async function assignDormantComebackEmailCandidates(): Promise<number> {
  if (
    !config.DORMANT_COMEBACK_EMAIL_EXPERIMENT_ENABLED
    || !config.RESEND_WEBHOOK_SECRET
    || !emailUnsubEnabled()
    || config.DORMANT_COMEBACK_EMAIL_ASSIGNMENT_CAP <= 0
  ) return 0;
  // Same reasoning as the weekend-league campaign above: the cap is spent, so
  // the scan cannot produce an assignment.
  if (!(await retentionEmailRepo.hasCampaignCapacity(
    DORMANT_COMEBACK_EMAIL_CAMPAIGN_KEY,
    config.DORMANT_COMEBACK_EMAIL_ASSIGNMENT_CAP,
  ))) return 0;
  const candidates = await retentionEmailRepo.listDormantCandidates({
    campaignKey: DORMANT_COMEBACK_EMAIL_CAMPAIGN_KEY,
    featureFlagKey: DORMANT_COMEBACK_EMAIL_FEATURE_FLAG_KEY,
    exclusionTtlDays: Math.min(RETENTION_FLAG_EXCLUSION_TTL_DAYS, config.DORMANT_COMEBACK_EMAIL_MIN_INACTIVE_DAYS),
    minInactiveDays: config.DORMANT_COMEBACK_EMAIL_MIN_INACTIVE_DAYS,
    maxInactiveDays: config.DORMANT_COMEBACK_EMAIL_MAX_INACTIVE_DAYS,
    minLifetimeMatches: config.DORMANT_COMEBACK_EMAIL_MIN_LIFETIME_MATCHES,
    frequencyDays: config.RETENTION_EMAIL_FREQUENCY_DAYS,
    userIdAllowlist: config.DORMANT_COMEBACK_EMAIL_USER_ID_ALLOWLIST,
    limit: Math.min(
      config.RETENTION_EMAIL_BATCH_SIZE,
      config.DORMANT_COMEBACK_EMAIL_ASSIGNMENT_CAP,
    ),
  });

  let assigned = 0;
  for (const candidate of candidates) {
    const variant = await resolveRetentionVariant({
      featureFlagKey: DORMANT_COMEBACK_EMAIL_FEATURE_FLAG_KEY,
      userId: candidate.user_id,
      country: candidate.country,
      logContext: 'Retention email',
    });
    if (!variant) continue;
    const assignment = await retentionEmailRepo.insertAssignment({
      campaignKey: DORMANT_COMEBACK_EMAIL_CAMPAIGN_KEY,
      featureFlagKey: DORMANT_COMEBACK_EMAIL_FEATURE_FLAG_KEY,
      candidate,
      variant,
      assignmentCap: config.DORMANT_COMEBACK_EMAIL_ASSIGNMENT_CAP,
    });
    if (!assignment) continue;
    assigned += 1;
    const properties = assignmentAnalyticsProperties(assignment);
    trackEvent('$feature_flag_called', assignment.user_id, {
      $feature_flag: DORMANT_COMEBACK_EMAIL_FEATURE_FLAG_KEY,
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
    && !config.DORMANT_COMEBACK_EMAIL_EXPERIMENT_ENABLED
    && !config.REACTIVATION_JOURNEY_ENABLED
  ) return 0;
  if (
    !config.RESEND_WEBHOOK_SECRET
    || !emailUnsubEnabled()
  ) return 0;
  await retentionEmailRepo.recoverStaleClaims(MAX_ATTEMPTS, STALE_CLAIM_MINUTES);
  await retentionEmailRepo.cancelInvalidPending();

  let sent = 0;
  for (let count = 0; count < config.RETENTION_EMAIL_BATCH_SIZE; count += 1) {
    const assignment = await retentionEmailRepo.claimOne(
      MAX_ATTEMPTS,
      config.REACTIVATION_JOURNEY_ENABLED,
    );
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
      message_kind: assignment.message_kind,
      cta_state: assignment.cta_state,
      destination: assignment.destination_path,
      journey_enrollment_id: assignment.journey_enrollment_id,
      milestone_days: assignment.milestone_days,
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
    message_kind: assignment.message_kind,
    cta_state: assignment.cta_state,
    destination: assignment.destination_path,
    journey_enrollment_id: assignment.journey_enrollment_id,
    milestone_days: assignment.milestone_days,
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
