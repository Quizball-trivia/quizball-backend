import { beforeEach, describe, expect, it, vi } from 'vitest';

// Analytics must never affect gameplay: a failing capture is swallowed, and nothing is sent before the commit.
const track = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/analytics.js', () => ({
  trackEvent: track,
  stableAnalyticsEventUuid: (key: string) => `uuid:${key}`,
}));
const begin = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/index.js', () => ({ sql: { begin } }));
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { partnerBegin, recordPartnerEvent, trackPartnerEvent } = await import('../../src/modules/partners/partner-analytics.js');

const event = {
  event: 'partner_play_started' as const,
  userId: '11111111-1111-4111-8111-111111111111',
  slug: 'freecroco',
  partnerEnvironment: 'production',
  key: 'play-1',
  properties: { game_id: 'countdown', end_cause: undefined },
};

beforeEach(() => {
  vi.clearAllMocks();
  begin.mockImplementation(async (work: (tx: object) => unknown) => work(() => undefined));
});

describe('partner analytics', () => {
  it('tags the partner and drops undefined properties', () => {
    trackPartnerEvent(event);
    expect(track).toHaveBeenCalledWith(
      'partner_play_started',
      event.userId,
      { game_id: 'countdown', partner_slug: 'freecroco', partner_environment: 'production' },
      { uuid: 'uuid:partner_play_started:play-1', occurredAt: undefined },
    );
  });

  it('a failing capture never reaches the caller', async () => {
    track.mockImplementation(() => {
      throw new Error('posthog down');
    });
    await expect(partnerBegin(async (tx) => {
      recordPartnerEvent(tx, event);
      return 'committed';
    })).resolves.toBe('committed');
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('sends only after the transaction callback has finished, and nothing when the commit fails', async () => {
    let sentInside = -1;
    await partnerBegin(async (tx) => {
      recordPartnerEvent(tx, event);
      sentInside = track.mock.calls.length;
    });
    expect(sentInside).toBe(0);
    expect(track).toHaveBeenCalledTimes(1);

    track.mockClear();
    begin.mockImplementationOnce(async (work: (tx: object) => unknown) => {
      await work(() => undefined);
      throw new Error('commit failed');
    });
    await expect(partnerBegin(async (tx) => recordPartnerEvent(tx, event))).rejects.toThrow('commit failed');
    expect(track).not.toHaveBeenCalled();
  });
});
