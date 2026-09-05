import { beforeEach, describe, expect, it, vi } from 'vitest';

const listEligibleCandidatesMock = vi.fn();
const hasCampaignCapacityMock = vi.fn();
const listDormantCandidatesMock = vi.fn();
const insertAssignmentMock = vi.fn();
const recoverStaleClaimsMock = vi.fn();
const cancelInvalidPendingMock = vi.fn();
const claimOneMock = vi.fn();
const markDeliveryMock = vi.fn();
const getClickAssignmentMock = vi.fn();
const markClickedMock = vi.fn();
const markUnsubscribedMock = vi.fn();
const applyProviderEventMock = vi.fn();
const resolveVariantMock = vi.fn();
const trackEventMock = vi.fn();
const sendEmailDetailedMock = vi.fn();
const verifyEmailLinkTokenMock = vi.fn();

vi.mock('../../src/modules/retention-email/retention-email.repo.js', () => ({
  retentionEmailRepo: {
    listEligibleCandidates: (...args: unknown[]) => listEligibleCandidatesMock(...args),
    hasCampaignCapacity: (...args: unknown[]) => hasCampaignCapacityMock(...args),
    listDormantCandidates: (...args: unknown[]) => listDormantCandidatesMock(...args),
    insertAssignment: (...args: unknown[]) => insertAssignmentMock(...args),
    recoverStaleClaims: (...args: unknown[]) => recoverStaleClaimsMock(...args),
    cancelInvalidPending: (...args: unknown[]) => cancelInvalidPendingMock(...args),
    claimOne: (...args: unknown[]) => claimOneMock(...args),
    markDelivery: (...args: unknown[]) => markDeliveryMock(...args),
    getClickAssignment: (...args: unknown[]) => getClickAssignmentMock(...args),
    markClicked: (...args: unknown[]) => markClickedMock(...args),
    markUnsubscribed: (...args: unknown[]) => markUnsubscribedMock(...args),
    applyProviderEvent: (...args: unknown[]) => applyProviderEventMock(...args),
  },
}));

vi.mock('../../src/core/config.js', () => ({
  config: {
    RETENTION_EMAIL_EXPERIMENT_ENABLED: true,
    RETENTION_EMAIL_MIN_INACTIVE_DAYS: 3,
    RETENTION_EMAIL_MAX_INACTIVE_DAYS: 7,
    RETENTION_EMAIL_FREQUENCY_DAYS: 7,
    RETENTION_EMAIL_MIN_LEAD_HOURS: 18,
    RETENTION_EMAIL_MAX_LEAD_HOURS: 24,
    RETENTION_EMAIL_BATCH_SIZE: 25,
    RETENTION_EMAIL_ASSIGNMENT_CAP: 100,
    RETENTION_EMAIL_USER_ID_ALLOWLIST: [],
    DORMANT_COMEBACK_EMAIL_EXPERIMENT_ENABLED: true,
    DORMANT_COMEBACK_EMAIL_MIN_INACTIVE_DAYS: 14,
    DORMANT_COMEBACK_EMAIL_MAX_INACTIVE_DAYS: 90,
    DORMANT_COMEBACK_EMAIL_MIN_LIFETIME_MATCHES: 3,
    DORMANT_COMEBACK_EMAIL_ASSIGNMENT_CAP: 200,
    DORMANT_COMEBACK_EMAIL_USER_ID_ALLOWLIST: [],
    REACTIVATION_JOURNEY_ENABLED: true,
    REACTIVATION_JOURNEY_BATCH_SIZE: 25,
    REACTIVATION_JOURNEY_USER_ID_ALLOWLIST: [],
    RESEND_WEBHOOK_SECRET: 'whsec_test',
    API_BASE_URL: 'https://api.quizball.test',
    PUBLIC_SITE_ORIGIN: 'https://quizball.test',
  },
}));

vi.mock('../../src/modules/retention-email/retention-flag.js', () => ({
  resolveRetentionVariant: (...args: unknown[]) => resolveVariantMock(...args),
}));
vi.mock('../../src/modules/retention-email/retention-flag-exclusions.repo.js', () => ({
  RETENTION_FLAG_EXCLUSION_TTL_DAYS: 3,
}));

vi.mock('../../src/core/analytics.js', () => ({
  stableAnalyticsEventUuid: (key: string) => `uuid:${key}`,
  trackEvent: (...args: unknown[]) => trackEventMock(...args),
}));

vi.mock('../../src/core/email.js', () => ({
  emailLinkToken: (purpose: string, payload: string) =>
    Buffer.from(`${purpose}:${payload}`).toString('hex').slice(0, 64).padEnd(64, '0'),
  emailUnsubEnabled: () => true,
  marketingEmailHeaders: () => ({ 'List-Unsubscribe': '<legacy>' }),
  sendEmailDetailed: (...args: unknown[]) => sendEmailDetailedMock(...args),
  verifyEmailLinkToken: (...args: unknown[]) => verifyEmailLinkTokenMock(...args),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  assignDormantComebackEmailCandidates,
  assignRetentionEmailCandidates,
  buildRetentionEmail,
  deliverRetentionEmails,
  handleRetentionEmailClick,
  handleRetentionEmailProviderEvent,
} from '../../src/modules/retention-email/retention-email.service.js';

const candidate = (userId: string) => ({
  user_id: userId,
  email: `${userId}@example.com`,
  nickname: 'Nika',
  preferred_language: 'ka',
  country: 'GE',
  tournament_id: '11111111-1111-4111-8111-111111111111',
  entry_closes_at: '2026-08-25T12:00:00.000Z',
  message_kind: 'weekend_league' as const,
  qp_remaining: 40,
  lifetime_matches: 12,
  cta_state: 'qualifying' as const,
  destination_path: '/play' as const,
  last_match_started_at: '2026-08-20T12:00:00.000Z',
});

const assignment = (userId = '22222222-2222-4222-8222-222222222222') => ({
  ...candidate(userId),
  id: '33333333-3333-4333-8333-333333333333',
  campaign_key: 'weekend_league_comeback_v1',
  feature_flag_key: 'email-comeback-weekend-league',
  variant: 'test' as const,
  assigned_at: '2026-08-24T12:00:00.000Z',
  send_status: 'sending' as const,
  attempts: 1,
});

describe('retention email experiment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Capacity gate open by default; the capped INSERT remains the authority.
    hasCampaignCapacityMock.mockResolvedValue(true);
    listDormantCandidatesMock.mockResolvedValue([]);
    recoverStaleClaimsMock.mockResolvedValue(undefined);
    cancelInvalidPendingMock.mockResolvedValue(undefined);
    markDeliveryMock.mockResolvedValue(undefined);
    verifyEmailLinkTokenMock.mockReturnValue(true);
  });

  it('persists both variants before emitting their PostHog exposures', async () => {
    const controlCandidate = candidate('44444444-4444-4444-8444-444444444444');
    const testCandidate = candidate('55555555-5555-4555-8555-555555555555');
    listEligibleCandidatesMock.mockResolvedValue([controlCandidate, testCandidate]);
    resolveVariantMock
      .mockResolvedValueOnce('control')
      .mockResolvedValueOnce('test');
    insertAssignmentMock.mockImplementation(async ({ candidate: value, variant }) => ({
      ...assignment(value.user_id),
      ...value,
      variant,
      send_status: variant === 'test' ? 'pending' : 'not_applicable',
    }));

    await expect(assignRetentionEmailCandidates()).resolves.toBe(2);

    expect(insertAssignmentMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      variant: 'control',
      assignmentCap: 100,
    }));
    expect(insertAssignmentMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      variant: 'test',
    }));
    expect(trackEventMock).toHaveBeenCalledWith(
      '$feature_flag_called',
      controlCandidate.user_id,
      expect.objectContaining({
        $feature_flag: 'email-comeback-weekend-league',
        $feature_flag_response: 'control',
      }),
      expect.any(Object),
    );
    expect(trackEventMock).toHaveBeenCalledWith(
      'retention_email_assigned',
      testCandidate.user_id,
      expect.objectContaining({ variant: 'test' }),
      expect.any(Object),
    );
  });

  it('skips candidates the flag resolver does not place in a variant', async () => {
    listEligibleCandidatesMock.mockResolvedValue([candidate('66666666-6666-4666-8666-666666666666')]);
    resolveVariantMock.mockResolvedValue(null);

    await expect(assignRetentionEmailCandidates()).resolves.toBe(0);
    expect(resolveVariantMock).toHaveBeenCalledWith({
      featureFlagKey: 'email-comeback-weekend-league',
      userId: '66666666-6666-4666-8666-666666666666',
      country: 'GE',
      logContext: 'Retention email',
    });
    expect(insertAssignmentMock).not.toHaveBeenCalled();
    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it('scopes the candidate scans to the campaign flag so exclusions apply', async () => {
    listEligibleCandidatesMock.mockResolvedValue([]);

    await assignRetentionEmailCandidates();
    await assignDormantComebackEmailCandidates();

    // TTL clamps to the campaign's own inactivity floor (3 and 14 days in this config).
    expect(listEligibleCandidatesMock).toHaveBeenCalledWith(expect.objectContaining({
      campaignKey: 'weekend_league_comeback_v1',
      featureFlagKey: 'email-comeback-weekend-league',
      exclusionTtlDays: 3,
    }));
    expect(listDormantCandidatesMock).toHaveBeenCalledWith(expect.objectContaining({
      campaignKey: 'dormant_player_comeback_v1',
      featureFlagKey: 'email-comeback-dormant-players',
      exclusionTtlDays: 3,
    }));
  });

  it('assigns established dormant players through a separate feature flag and cap', async () => {
    const dormantCandidate = {
      ...candidate('77777777-7777-4777-8777-777777777777'),
      tournament_id: null,
      entry_closes_at: null,
      message_kind: 'dormant_comeback' as const,
      qp_remaining: 0,
      lifetime_matches: 18,
      cta_state: 'comeback' as const,
      destination_path: '/play' as const,
      last_match_started_at: '2026-07-10T12:00:00.000Z',
    };
    listDormantCandidatesMock.mockResolvedValue([dormantCandidate]);
    resolveVariantMock.mockResolvedValue('test');
    insertAssignmentMock.mockImplementation(async ({ candidate: value, variant }) => ({
      ...assignment(value.user_id),
      ...value,
      campaign_key: 'dormant_player_comeback_v1',
      feature_flag_key: 'email-comeback-dormant-players',
      variant,
      send_status: 'pending',
    }));

    await expect(assignDormantComebackEmailCandidates()).resolves.toBe(1);

    expect(resolveVariantMock).toHaveBeenCalledWith(expect.objectContaining({
      featureFlagKey: 'email-comeback-dormant-players',
      userId: dormantCandidate.user_id,
    }));
    expect(insertAssignmentMock).toHaveBeenCalledWith(expect.objectContaining({
      campaignKey: 'dormant_player_comeback_v1',
      assignmentCap: 200,
    }));
    expect(trackEventMock).toHaveBeenCalledWith(
      'retention_email_assigned',
      dormantCandidate.user_id,
      expect.objectContaining({
        message_kind: 'dormant_comeback',
        lifetime_matches: 18,
      }),
      expect.any(Object),
    );
  });

  it('sends the test email once and records provider acceptance', async () => {
    const value = assignment();
    claimOneMock.mockResolvedValueOnce(value).mockResolvedValueOnce(null);
    sendEmailDetailedMock.mockResolvedValue({ accepted: true, messageId: 'provider-1' });

    await expect(deliverRetentionEmails()).resolves.toBe(1);

    expect(sendEmailDetailedMock).toHaveBeenCalledWith(expect.objectContaining({
      to: value.email,
      idempotencyKey: `retention-email:${value.id}`,
      subject: expect.stringContaining('უიქენდის ლიგამდე'),
      html: expect.stringContaining('40 QP'),
    }));
    expect(markDeliveryMock).toHaveBeenCalledWith({
      assignmentId: value.id,
      accepted: true,
      providerMessageId: 'provider-1',
      maxAttempts: 5,
    });
    expect(trackEventMock).toHaveBeenCalledWith(
      'retention_email_sent',
      value.user_id,
      expect.objectContaining({ cta_state: 'qualifying', attempt: 1 }),
      expect.any(Object),
    );
  });

  it('builds state-aware copy without promising an unbacked reward', () => {
    const value = assignment();
    const email = buildRetentionEmail(
      value,
      'https://api.quizball.test/click',
      'https://api.quizball.test/unsubscribe',
      new Date('2026-08-24T12:00:00.000Z'),
    );

    expect(email.html).toContain('40 QP');
    expect(email.html).toContain('ითამაშე Ranked');
    expect(email.html).not.toMatch(/coin|მონეტ|free item|უფასო/i);
  });

  it('builds a general dormant-player comeback email without a League deadline or reward', () => {
    const value = {
      ...assignment(),
      tournament_id: null,
      entry_closes_at: null,
      message_kind: 'dormant_comeback' as const,
      cta_state: 'comeback' as const,
      qp_remaining: 0,
    };
    const email = buildRetentionEmail(
      value,
      'https://api.quizball.test/click',
      'https://api.quizball.test/unsubscribe',
    );

    expect(email.subject).toContain('Quizball');
    expect(email.html).toContain('ითამაშე ახლა');
    expect(email.html).not.toMatch(/QP|coin|მონეტ|free item|უფასო|უიქენდ/i);
  });

  it('builds milestone-specific journey copy and never invents a reward', () => {
    const value = {
      ...assignment(),
      tournament_id: null,
      entry_closes_at: null,
      message_kind: 'dormant_journey' as const,
      cta_state: 'comeback' as const,
      destination_path: '/auction' as const,
      qp_remaining: 0,
      journey_enrollment_id: '88888888-8888-4888-8888-888888888888',
      milestone_days: 14 as const,
      scheduled_for: '2026-08-24T12:00:00.000Z',
    };
    const email = buildRetentionEmail(
      value,
      'https://api.quizball.test/click',
      'https://api.quizball.test/unsubscribe',
    );

    expect(email.subject).toContain('Auction');
    expect(email.html).toContain('ითამაშე Auction');
    expect(email.html).not.toMatch(/coin|მონეტ|free item|უფასო/i);
  });

  it('uses database country for journey language instead of the language preference', () => {
    const baseJourney = {
      ...assignment(),
      tournament_id: null,
      entry_closes_at: null,
      message_kind: 'dormant_journey' as const,
      cta_state: 'comeback' as const,
      destination_path: '/auction' as const,
      qp_remaining: 0,
      journey_enrollment_id: '88888888-8888-4888-8888-888888888888',
      milestone_days: 14 as const,
      scheduled_for: '2026-08-24T12:00:00.000Z',
    };
    const georgian = buildRetentionEmail(
      { ...baseJourney, country: 'GE', preferred_language: 'en' },
      'https://api.quizball.test/click',
      'https://api.quizball.test/unsubscribe',
    );
    const english = buildRetentionEmail(
      { ...baseJourney, country: 'GR', preferred_language: 'ka' },
      'https://api.quizball.test/click',
      'https://api.quizball.test/unsubscribe',
    );
    const missingCountry = buildRetentionEmail(
      { ...baseJourney, country: null, preferred_language: 'ka' },
      'https://api.quizball.test/click',
      'https://api.quizball.test/unsubscribe',
    );

    expect(georgian.html).toContain('ითამაშე Auction');
    expect(english.html).toContain('Play Auction');
    expect(english.html).not.toContain('ითამაშე Auction');
    expect(missingCountry.html).toContain('Play Auction');
  });

  it('records an idempotent click and redirects only to the stored destination', async () => {
    const value = assignment();
    getClickAssignmentMock.mockResolvedValue({
      id: value.id,
      user_id: value.user_id,
      campaign_key: value.campaign_key,
      variant: 'test',
      message_kind: 'weekend_league',
      cta_state: 'qualifying',
      destination_path: '/play',
      send_status: 'sent',
      clicked_at: null,
    });
    markClickedMock.mockResolvedValue({
      clicked_at: '2026-08-24T13:00:00.000Z',
      first_click: true,
    });

    const destination = await handleRetentionEmailClick(value.id, 'valid');

    expect(destination).toBe(
      `https://quizball.test/play?utm_source=retention_email&utm_medium=email&utm_campaign=weekend_league_comeback_v1&utm_content=qualifying&retention_assignment=${value.id}`,
    );
    expect(trackEventMock).toHaveBeenCalledWith(
      'retention_email_clicked',
      value.user_id,
      expect.objectContaining({ destination: '/play' }),
      expect.any(Object),
    );
  });

  it('turns a deduplicated provider bounce into the delivery guardrail event', async () => {
    const value = assignment();
    applyProviderEventMock.mockResolvedValue({
      id: value.id,
      user_id: value.user_id,
      campaign_key: value.campaign_key,
      variant: 'test',
      message_kind: 'weekend_league',
      cta_state: 'qualifying',
      destination_path: '/play',
    });

    await handleRetentionEmailProviderEvent({
      eventId: 'webhook-1',
      eventType: 'email.bounced',
      providerMessageId: 'provider-message-1',
      occurredAt: '2026-08-24T13:00:00.000Z',
    });

    expect(applyProviderEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'webhook-1',
      eventType: 'email.bounced',
    }));
    expect(trackEventMock).toHaveBeenCalledWith(
      'retention_email_delivery_failed',
      value.user_id,
      expect.objectContaining({ provider_status: 'bounced' }),
      expect.any(Object),
    );
  });

  it('records provider opens as a diagnostic rather than a conversion', async () => {
    const value = assignment();
    applyProviderEventMock.mockResolvedValue({
      id: value.id,
      user_id: value.user_id,
      campaign_key: value.campaign_key,
      variant: 'test',
      message_kind: 'weekend_league',
      cta_state: 'qualifying',
      destination_path: '/play',
    });

    await handleRetentionEmailProviderEvent({
      eventId: 'webhook-open-1',
      eventType: 'email.opened',
      providerMessageId: 'provider-message-1',
      occurredAt: '2026-08-24T13:05:00.000Z',
    });

    expect(applyProviderEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'email.opened',
    }));
    expect(trackEventMock).toHaveBeenCalledWith(
      'retention_email_opened',
      value.user_id,
      expect.objectContaining({ provider_status: 'opened' }),
      expect.any(Object),
    );
  });
});
