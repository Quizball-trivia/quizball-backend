import { stableAnalyticsEventUuid, trackEvent } from '../../core/analytics.js';
import { config } from '../../core/config.js';
import { emailUnsubEnabled } from '../../core/email.js';
import { resolveRetentionVariant } from './retention-flag.js';
import {
  REACTIVATION_JOURNEY_KEY,
  retentionJourneyRepo,
  type JourneyConfig,
} from './retention-journey.repo.js';

function journeyEnabled(journeyConfig: JourneyConfig | null): journeyConfig is JourneyConfig {
  return Boolean(
    config.REACTIVATION_JOURNEY_ENABLED
    && config.RESEND_WEBHOOK_SECRET
    && emailUnsubEnabled()
    && journeyConfig
    && (journeyConfig.status === 'canary' || journeyConfig.status === 'live')
    && journeyConfig.assignment_cap > 0,
  );
}

export async function assignReactivationJourneyCandidates(): Promise<number> {
  const journeyConfig = await retentionJourneyRepo.getConfig();
  if (!journeyEnabled(journeyConfig)) return 0;
  // The candidate scan is the single most expensive statement in the system
  // (827.9 ms mean on prod). Skip it outright once the caps are spent — which
  // they are for most of the day, since the daily cap is reached every day.
  if (!(await retentionJourneyRepo.hasJourneyCapacityToday(journeyConfig))) return 0;
  const candidates = await retentionJourneyRepo.listEnrollmentCandidates({
    config: journeyConfig,
    userIdAllowlist: config.REACTIVATION_JOURNEY_USER_ID_ALLOWLIST,
    limit: Math.min(
      config.REACTIVATION_JOURNEY_BATCH_SIZE,
      journeyConfig.daily_assignment_cap,
      journeyConfig.assignment_cap,
    ),
  });

  let assigned = 0;
  for (const candidate of candidates) {
    const variant = await resolveRetentionVariant({
      featureFlagKey: journeyConfig.feature_flag_key,
      userId: candidate.user_id,
      country: candidate.country,
      logContext: 'Reactivation journey',
    });
    if (!variant) continue;
    const enrollment = await retentionJourneyRepo.insertEnrollment({
      config: journeyConfig,
      candidate,
      variant,
    });
    if (!enrollment) continue;
    assigned += 1;
    const inactivityDays = Math.max(0, Math.floor(
      (Date.parse(enrollment.entered_at) - Date.parse(enrollment.last_match_started_at))
      / (24 * 60 * 60 * 1_000),
    ));
    const normalizedCountry = candidate.country?.trim().toUpperCase() || 'UNKNOWN';
    const properties = {
      journey_key: enrollment.journey_key,
      journey_version: enrollment.journey_version,
      variant,
      entry_milestone_days: enrollment.entry_milestone_days,
      inactivity_days: inactivityDays,
      lifetime_matches: enrollment.lifetime_matches,
      country_code: normalizedCountry,
      content_language: normalizedCountry === 'GE' ? 'ka' : 'en',
      channel: variant === 'test' ? 'email' : 'holdout',
    };
    trackEvent('$feature_flag_called', enrollment.user_id, {
      $feature_flag: journeyConfig.feature_flag_key,
      $feature_flag_response: variant,
      ...properties,
    }, {
      uuid: stableAnalyticsEventUuid(`reactivation-journey:exposure:${enrollment.id}`),
      occurredAt: enrollment.entered_at,
    });
    trackEvent('reactivation_journey_entered', enrollment.user_id, properties, {
      uuid: stableAnalyticsEventUuid(`reactivation-journey:entered:${enrollment.id}`),
      occurredAt: enrollment.entered_at,
    });
  }
  return assigned;
}

// The exit sweep aggregates every enrolled player's match history (82 ms mean,
// the single heaviest statement on prod when it ran every 60s tick). Due steps
// carry their own returned-player guard, so the sweep only decides how soon an
// enrollment is marked exited — minutes, against milestones measured in days.
const EXIT_SWEEP_INTERVAL_MS = 10 * 60_000;
let lastExitSweepAt = 0;

/** @internal test seam. */
export function resetReactivationJourneySweepForTests(): void {
  lastExitSweepAt = 0;
}

export async function scheduleReactivationJourneySteps(): Promise<{
  exited: number;
  scheduled: number;
}> {
  const journeyConfig = await retentionJourneyRepo.getConfig();
  if (!journeyEnabled(journeyConfig)) return { exited: 0, scheduled: 0 };
  let exited = 0;
  if (Date.now() - lastExitSweepAt >= EXIT_SWEEP_INTERVAL_MS) {
    exited = await retentionJourneyRepo.exitIneligibleEnrollments();
    lastExitSweepAt = Date.now();
  }
  const due = await retentionJourneyRepo.listDueSteps({
    config: journeyConfig,
    limit: Math.min(config.REACTIVATION_JOURNEY_BATCH_SIZE, journeyConfig.daily_send_cap),
  });
  let scheduled = 0;
  for (const step of due) {
    const assignment = await retentionJourneyRepo.insertDueStep({ config: journeyConfig, step });
    if (!assignment) continue;
    scheduled += 1;
    const normalizedCountry = step.country?.trim().toUpperCase() || 'UNKNOWN';
    trackEvent('reactivation_journey_step_scheduled', step.user_id, {
      journey_key: step.journey_key,
      journey_version: step.journey_version,
      variant: step.variant,
      milestone_days: step.milestone_days,
      destination: assignment.destination_path,
      country_code: normalizedCountry,
      content_language: normalizedCountry === 'GE' ? 'ka' : 'en',
      channel: 'email',
    }, {
      uuid: stableAnalyticsEventUuid(`reactivation-journey:scheduled:${assignment.id}`),
      occurredAt: assignment.assigned_at,
    });
  }
  return { exited, scheduled };
}

export async function getReactivationJourneyDashboard() {
  const [journeyConfig, segments, funnel, steps] = await Promise.all([
    retentionJourneyRepo.getConfig(),
    retentionJourneyRepo.getSegments(),
    retentionJourneyRepo.getFunnel(),
    retentionJourneyRepo.getStepSummary(),
  ]);
  if (!journeyConfig) return null;
  return {
    config: {
      ...journeyConfig,
      runtime_enabled: config.REACTIVATION_JOURNEY_ENABLED,
      email_provider_ready: Boolean(config.RESEND_WEBHOOK_SECRET) && emailUnsubEnabled(),
      sms_explanation: 'Verified phone is not marketing consent. SMS stays locked until opt-in and STOP handling are live.',
    },
    segments,
    funnel,
    steps,
    journey: [
      { milestone_days: 3, title: 'Daily Challenge', destination: '/daily/challenges' },
      { milestone_days: 7, title: 'Weekend League', destination: '/weekend-league' },
      { milestone_days: 14, title: 'Auction', destination: '/auction' },
      { milestone_days: 30, title: "What's new", destination: '/play' },
      { milestone_days: 60, title: 'One-match comeback', destination: '/play' },
    ],
    experiment: {
      feature_flag_key: journeyConfig.feature_flag_key,
      decision_metric: 'match_started within 72 hours of enrollment',
      retention_metric: 'at least three matches started within seven days',
      guardrails: ['delivery failures', 'complaints', 'unsubscribes', 'weekly contact cap'],
    },
  };
}

export async function pauseReactivationJourney(adminUserId: string) {
  return retentionJourneyRepo.pause(adminUserId);
}

export { REACTIVATION_JOURNEY_KEY };
