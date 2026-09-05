import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getConfigMock = vi.fn();
const listEnrollmentCandidatesMock = vi.fn();
const hasJourneyCapacityTodayMock = vi.fn();
const insertEnrollmentMock = vi.fn();
const exitIneligibleEnrollmentsMock = vi.fn();
const listDueStepsMock = vi.fn();
const insertDueStepMock = vi.fn();
const getSegmentsMock = vi.fn();
const getFunnelMock = vi.fn();
const getStepSummaryMock = vi.fn();
const pauseMock = vi.fn();
const resolveVariantMock = vi.fn();
const trackEventMock = vi.fn();

vi.mock('../../src/modules/retention-email/retention-journey.repo.js', () => ({
  REACTIVATION_JOURNEY_KEY: 'dormant_reactivation',
  retentionJourneyRepo: {
    getConfig: (...args: unknown[]) => getConfigMock(...args),
    listEnrollmentCandidates: (...args: unknown[]) => listEnrollmentCandidatesMock(...args),
    hasJourneyCapacityToday: (...args: unknown[]) => hasJourneyCapacityTodayMock(...args),
    insertEnrollment: (...args: unknown[]) => insertEnrollmentMock(...args),
    exitIneligibleEnrollments: (...args: unknown[]) => exitIneligibleEnrollmentsMock(...args),
    listDueSteps: (...args: unknown[]) => listDueStepsMock(...args),
    insertDueStep: (...args: unknown[]) => insertDueStepMock(...args),
    getSegments: (...args: unknown[]) => getSegmentsMock(...args),
    getFunnel: (...args: unknown[]) => getFunnelMock(...args),
    getStepSummary: (...args: unknown[]) => getStepSummaryMock(...args),
    pause: (...args: unknown[]) => pauseMock(...args),
  },
}));

vi.mock('../../src/core/config.js', () => ({
  config: {
    REACTIVATION_JOURNEY_ENABLED: true,
    REACTIVATION_JOURNEY_BATCH_SIZE: 25,
    REACTIVATION_JOURNEY_USER_ID_ALLOWLIST: [],
    RESEND_WEBHOOK_SECRET: 'whsec_test',
  },
}));

vi.mock('../../src/modules/retention-email/retention-flag.js', () => ({
  resolveRetentionVariant: (...args: unknown[]) => resolveVariantMock(...args),
}));
vi.mock('../../src/core/email.js', () => ({ emailUnsubEnabled: () => true }));
vi.mock('../../src/core/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/core/analytics.js', () => ({
  stableAnalyticsEventUuid: (key: string) => `uuid:${key}`,
  trackEvent: (...args: unknown[]) => trackEventMock(...args),
}));

import {
  assignReactivationJourneyCandidates,
  resetReactivationJourneySweepForTests,
  scheduleReactivationJourneySteps,
} from '../../src/modules/retention-email/retention-journey.service.js';

const journeyConfig = {
  journey_key: 'dormant_reactivation',
  version: 1,
  feature_flag_key: 'dormant-reactivation-journey-v1',
  status: 'canary' as const,
  assignment_cap: 400,
  daily_assignment_cap: 50,
  daily_send_cap: 25,
  min_lifetime_matches: 1,
  quiet_hours_start: 21,
  quiet_hours_end: 10,
  email_frequency_days: 7,
  sms_status: 'locked' as const,
  updated_at: '2026-08-27T08:00:00.000Z',
};

const candidate = {
  user_id: '11111111-1111-4111-8111-111111111111',
  email: 'player@example.com',
  nickname: 'Nika',
  preferred_language: 'ka',
  country: 'GE',
  last_match_started_at: '2026-08-12T08:00:00.000Z',
  lifetime_matches: 12,
  entry_milestone_days: 14 as const,
};

describe('durable reactivation journey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T08:00:00.000Z'));
    resetReactivationJourneySweepForTests();
    getConfigMock.mockResolvedValue(journeyConfig);
    listEnrollmentCandidatesMock.mockResolvedValue([]);
    // Capacity gate open by default; the capped INSERT is still the authority.
    hasJourneyCapacityTodayMock.mockResolvedValue(true);
    exitIneligibleEnrollmentsMock.mockResolvedValue(0);
    listDueStepsMock.mockResolvedValue([]);
    getSegmentsMock.mockResolvedValue([]);
    getFunnelMock.mockResolvedValue([]);
    getStepSummaryMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips the candidate scan once the daily cap is spent', async () => {

    // The scan aggregates users x match_players x matches and cost 827.9 ms

    // mean on prod — 61% of all database time — while the daily cap was

    // reached every day, so most ticks scanned and threw the result away.

    hasJourneyCapacityTodayMock.mockResolvedValue(false);


    const assigned = await assignReactivationJourneyCandidates();


    expect(assigned).toBe(0);

    expect(listEnrollmentCandidatesMock).not.toHaveBeenCalled();

  });


  it('still scans while capacity remains', async () => {

    hasJourneyCapacityTodayMock.mockResolvedValue(true);


    await assignReactivationJourneyCandidates();


    expect(listEnrollmentCandidatesMock).toHaveBeenCalled();

  });


  it('persists a stable control enrollment and emits one exposure', async () => {
    listEnrollmentCandidatesMock.mockResolvedValue([candidate]);
    resolveVariantMock.mockResolvedValue('control');
    insertEnrollmentMock.mockResolvedValue({
      ...candidate,
      id: '22222222-2222-4222-8222-222222222222',
      journey_key: journeyConfig.journey_key,
      journey_version: 1,
      feature_flag_key: journeyConfig.feature_flag_key,
      variant: 'control',
      entered_at: '2026-08-27T08:00:00.000Z',
      status: 'active',
    });

    await expect(assignReactivationJourneyCandidates()).resolves.toBe(1);
    expect(insertEnrollmentMock).toHaveBeenCalledWith(expect.objectContaining({
      candidate,
      variant: 'control',
    }));
    expect(trackEventMock).toHaveBeenCalledWith(
      '$feature_flag_called',
      candidate.user_id,
      expect.objectContaining({
        $feature_flag_response: 'control',
        channel: 'holdout',
        entry_milestone_days: 14,
        country_code: 'GE',
        content_language: 'ka',
      }),
      expect.any(Object),
    );
  });

  it('emits no exposure for a player PostHog assigns but the cap rejects', async () => {
    listEnrollmentCandidatesMock.mockResolvedValue([candidate]);
    resolveVariantMock.mockResolvedValue('control');
    insertEnrollmentMock.mockResolvedValue(null);

    await expect(assignReactivationJourneyCandidates()).resolves.toBe(0);
    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it('skips a candidate the flag resolver does not place in a variant', async () => {
    listEnrollmentCandidatesMock.mockResolvedValue([candidate]);
    resolveVariantMock.mockResolvedValue(null);

    await expect(assignReactivationJourneyCandidates()).resolves.toBe(0);
    expect(resolveVariantMock).toHaveBeenCalledWith({
      featureFlagKey: journeyConfig.feature_flag_key,
      userId: candidate.user_id,
      country: 'GE',
      logContext: 'Reactivation journey',
    });
    expect(insertEnrollmentMock).not.toHaveBeenCalled();
    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it('runs the exit sweep at most once per ten minutes while due steps keep flowing', async () => {
    exitIneligibleEnrollmentsMock.mockResolvedValue(2);

    await expect(scheduleReactivationJourneySteps()).resolves.toEqual({ exited: 2, scheduled: 0 });
    await expect(scheduleReactivationJourneySteps()).resolves.toEqual({ exited: 0, scheduled: 0 });
    expect(exitIneligibleEnrollmentsMock).toHaveBeenCalledTimes(1);
    expect(listDueStepsMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-09-05T08:09:59.000Z'));
    await scheduleReactivationJourneySteps();
    expect(exitIneligibleEnrollmentsMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-05T08:10:00.000Z'));
    await expect(scheduleReactivationJourneySteps()).resolves.toEqual({ exited: 2, scheduled: 0 });
    expect(exitIneligibleEnrollmentsMock).toHaveBeenCalledTimes(2);
  });

  it('runs one sweep for concurrent callers and retries after a failed sweep', async () => {
    let release: (n: number) => void = () => {};
    exitIneligibleEnrollmentsMock.mockImplementationOnce(() => new Promise<number>((resolve) => { release = resolve; }));

    const first = scheduleReactivationJourneySteps();
    const second = scheduleReactivationJourneySteps();
    await Promise.resolve();
    expect(exitIneligibleEnrollmentsMock).toHaveBeenCalledTimes(1);
    release(4);
    await expect(first).resolves.toEqual({ exited: 4, scheduled: 0 });
    await expect(second).resolves.toEqual({ exited: 4, scheduled: 0 });

    // A failed sweep must not advance the ten-minute clock.
    resetReactivationJourneySweepForTests();
    exitIneligibleEnrollmentsMock.mockRejectedValueOnce(new Error('db down'));
    await expect(scheduleReactivationJourneySteps()).rejects.toThrow('db down');
    exitIneligibleEnrollmentsMock.mockResolvedValueOnce(1);
    await expect(scheduleReactivationJourneySteps()).resolves.toEqual({ exited: 1, scheduled: 0 });
    expect(exitIneligibleEnrollmentsMock).toHaveBeenCalledTimes(3);
  });

  it('schedules only the due test step returned by the guarded repository', async () => {
    const step = {
      ...candidate,
      id: '22222222-2222-4222-8222-222222222222',
      journey_key: journeyConfig.journey_key,
      journey_version: 1,
      feature_flag_key: journeyConfig.feature_flag_key,
      variant: 'test' as const,
      entered_at: '2026-08-27T08:00:00.000Z',
      status: 'active' as const,
      milestone_days: 14 as const,
    };
    exitIneligibleEnrollmentsMock.mockResolvedValue(3);
    listDueStepsMock.mockResolvedValue([step]);
    insertDueStepMock.mockResolvedValue({
      ...step,
      id: '33333333-3333-4333-8333-333333333333',
      campaign_key: 'campaign',
      message_kind: 'dormant_journey',
      cta_state: 'comeback',
      destination_path: '/auction',
      qp_remaining: 0,
      tournament_id: null,
      entry_closes_at: null,
      assigned_at: '2026-08-27T08:01:00.000Z',
      send_status: 'pending',
      attempts: 0,
      journey_enrollment_id: step.id,
      scheduled_for: '2026-08-27T08:01:00.000Z',
    });

    await expect(scheduleReactivationJourneySteps()).resolves.toEqual({ exited: 3, scheduled: 1 });
    expect(insertDueStepMock).toHaveBeenCalledWith({ config: journeyConfig, step });
    expect(trackEventMock).toHaveBeenCalledWith(
      'reactivation_journey_step_scheduled',
      candidate.user_id,
      expect.objectContaining({
        milestone_days: 14,
        destination: '/auction',
        country_code: 'GE',
        content_language: 'ka',
      }),
      expect.any(Object),
    );
  });
});
