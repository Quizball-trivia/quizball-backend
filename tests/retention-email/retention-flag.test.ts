import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const recordExclusionMock = vi.fn();
const warnMock = vi.fn();
let postHogConfigured = true;

vi.mock('../../src/core/analytics.js', () => ({
  getPostHogFlagsConfig: () =>
    (postHogConfigured ? { apiKey: 'phc_test', host: 'https://us.i.posthog.com' } : null),
}));
vi.mock('../../src/core/logger.js', () => ({
  logger: { warn: (...args: unknown[]) => warnMock(...args), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/modules/retention-email/retention-flag-exclusions.repo.js', () => ({
  RETENTION_FLAG_EXCLUSION_TTL_DAYS: 3,
  retentionFlagExclusionRepo: { record: (...args: unknown[]) => recordExclusionMock(...args) },
}));

import {
  resetRetentionFlagBackoffForTests,
  resolveRetentionVariant,
} from '../../src/modules/retention-email/retention-flag.js';

const input = {
  featureFlagKey: 'email-comeback-dormant-players',
  userId: '11111111-1111-4111-8111-111111111111',
  country: 'GE',
  logContext: 'Retention email',
};

type Flag = { enabled: boolean; variant?: string; reason?: { code: string } };

function respond(
  flags: Record<string, Flag>,
  extra: Record<string, unknown> = {},
  status = 200,
) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ flags, ...extra }),
  });
}

describe('resolveRetentionVariant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T08:00:00.000Z'));
    vi.stubGlobal('fetch', fetchMock);
    resetRetentionFlagBackoffForTests();
    postHogConfigured = true;
    recordExclusionMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('asks the flags endpoint once for the player with their country', async () => {
    respond({ [input.featureFlagKey]: { enabled: true, variant: 'control', reason: { code: 'condition_match' } } });

    await expect(resolveRetentionVariant(input)).resolves.toBe('control');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://us.i.posthog.com/flags/?v=2');
    expect(JSON.parse(String(init.body))).toEqual({
      token: 'phc_test',
      distinct_id: input.userId,
      person_properties: { distinct_id: input.userId, country: 'GE' },
      flag_keys_to_evaluate: [input.featureFlagKey],
      evaluation_runtime: 'server',
      geoip_disable: true,
    });
    expect(recordExclusionMock).not.toHaveBeenCalled();
  });

  it('records a player the flag conditions reject instead of re-evaluating every tick', async () => {
    // This is the leak: 148,806 billed requests on 2026-09-03 for ~300
    // assignments, because a "does not match" answer was never remembered.
    respond({ [input.featureFlagKey]: { enabled: false, reason: { code: 'no_condition_match' } } });

    await expect(resolveRetentionVariant(input)).resolves.toBeNull();
    expect(recordExclusionMock).toHaveBeenCalledWith({
      featureFlagKey: input.featureFlagKey,
      userId: input.userId,
    });
  });

  it('records a player outside the rollout percentage', async () => {
    respond({ [input.featureFlagKey]: { enabled: false, reason: { code: 'out_of_rollout_bound' } } });

    await expect(resolveRetentionVariant(input)).resolves.toBeNull();
    expect(recordExclusionMock).toHaveBeenCalledTimes(1);
  });

  it('records a player bucketed into a variant the campaign does not run', async () => {
    respond({ [input.featureFlagKey]: { enabled: true, variant: 'variant-c', reason: { code: 'condition_match' } } });

    await expect(resolveRetentionVariant(input)).resolves.toBeNull();
    expect(recordExclusionMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['evaluation errors', { [input.featureFlagKey]: { enabled: false, reason: { code: 'no_condition_match' } } }, { errorsWhileComputingFlags: true }, 200],
    ['quota limit', {}, { quotaLimited: ['feature_flags'] }, 200],
    ['missing flag', { 'other-flag': { enabled: true, variant: 'test' } }, {}, 200],
    ['paused flag with an unlisted reason', { [input.featureFlagKey]: { enabled: false, reason: { code: 'disabled' } } }, {}, 200],
    ['disabled flag without a reason', { [input.featureFlagKey]: { enabled: false } }, {}, 200],
    ['boolean flag without a variant', { [input.featureFlagKey]: { enabled: true, reason: { code: 'condition_match' } } }, {}, 200],
    ['flag entry without an enabled field', { [input.featureFlagKey]: { reason: { code: 'no_condition_match' } } as unknown as Flag }, {}, 200],
    ['http error', {}, {}, 503],
  ])('treats %s as unknown: no exclusion, flag paused', async (_label, flags, extra, status) => {
    respond(flags as Record<string, Flag>, extra, status);

    await expect(resolveRetentionVariant(input)).resolves.toBeNull();
    expect(recordExclusionMock).not.toHaveBeenCalled();

    await expect(resolveRetentionVariant({ ...input, userId: '22222222-2222-4222-8222-222222222222' }))
      .resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a network failure as unknown', async () => {
    fetchMock.mockRejectedValueOnce(new Error('fetch failed'));

    await expect(resolveRetentionVariant(input)).resolves.toBeNull();
    expect(recordExclusionMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ featureFlagKey: input.featureFlagKey, reason: 'fetch failed' }),
      expect.stringContaining('pausing this flag'),
    );
  });

  it('treats a timeout abort as unknown', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    await expect(resolveRetentionVariant(input)).resolves.toBeNull();
    expect(recordExclusionMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'The operation was aborted due to timeout' }),
      expect.any(String),
    );
  });

  it('treats a malformed response body as unknown', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });

    await expect(resolveRetentionVariant(input)).resolves.toBeNull();
    expect(recordExclusionMock).not.toHaveBeenCalled();
  });

  it.each([['null', null], ['a string', 'ok'], ['an array', []]])(
    'treats a JSON body that is %s as unknown without throwing',
    async (_label, body) => {
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });

      await expect(resolveRetentionVariant(input)).resolves.toBeNull();
      expect(recordExclusionMock).not.toHaveBeenCalled();
    },
  );

  it('drains the body of an error response', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, body: { cancel }, json: async () => ({}) });

    await expect(resolveRetentionVariant(input)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('pauses only the unknown flag, and only for the backoff window', async () => {
    respond({}, {}, 500);
    await expect(resolveRetentionVariant(input)).resolves.toBeNull();

    respond({ 'email-comeback-weekend-league': { enabled: true, variant: 'test' } });
    await expect(resolveRetentionVariant({ ...input, featureFlagKey: 'email-comeback-weekend-league' }))
      .resolves.toBe('test');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-09-05T08:04:59.000Z'));
    await expect(resolveRetentionVariant(input)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-09-05T08:05:00.000Z'));
    respond({ [input.featureFlagKey]: { enabled: true, variant: 'test' } });
    await expect(resolveRetentionVariant(input)).resolves.toBe('test');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('pauses the flag when the exclusion write fails, so the player is not re-billed next tick', async () => {
    respond({ [input.featureFlagKey]: { enabled: false, reason: { code: 'no_condition_match' } } });
    recordExclusionMock.mockRejectedValue(new Error('db down'));

    await expect(resolveRetentionVariant(input)).resolves.toBeNull();
    await expect(resolveRetentionVariant(input)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null without a request when PostHog is not configured', async () => {
    postHogConfigured = false;

    await expect(resolveRetentionVariant(input)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordExclusionMock).not.toHaveBeenCalled();
  });

  it('sends an empty country rather than omitting the person property', async () => {
    respond({ [input.featureFlagKey]: { enabled: true, variant: 'test' } });

    await resolveRetentionVariant({ ...input, country: null });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).person_properties).toEqual({ distinct_id: input.userId, country: '' });
  });
});
