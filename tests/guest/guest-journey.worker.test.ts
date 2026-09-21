import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ sql: vi.fn(), captureImmediate: vi.fn(), client: true, config: { NODE_ENV: 'prod' } }));
vi.mock('../../src/db/index.js', () => ({ sql: mocks.sql }));
vi.mock('../../src/core/analytics.js', () => ({ getPostHogClient: () => mocks.client ? { captureImmediate: mocks.captureImmediate } : null }));
vi.mock('../../src/core/config.js', () => ({ config: mocks.config }));
vi.mock('../../src/core/logger.js', () => ({ logger: { warn: vi.fn() } }));
import { deliverGuestJourneyEvents } from '../../src/modules/guest/guest-journey.worker.js';
const row = { id: 'event-1', guest_id: 'guest-1', event: 'guest_converted', properties: { mode: 'ranked' }, occurred_at: '2026-09-21T00:00:00Z' };
beforeEach(() => { vi.clearAllMocks(); mocks.client = true; mocks.config.NODE_ENV = 'prod'; });
describe('durable PostHog guest delivery', () => {
  it('acknowledges only after confirmed capture with stable identity, UUID and original timestamp', async () => {
    mocks.sql.mockResolvedValueOnce([row]).mockResolvedValue([]); mocks.captureImmediate.mockResolvedValue(undefined);
    await deliverGuestJourneyEvents();
    expect(mocks.captureImmediate).toHaveBeenCalledWith(expect.objectContaining({ distinctId: 'guest-journey:guest-1', uuid: 'event-1', timestamp: new Date(row.occurred_at), properties: expect.objectContaining({ $process_person_profile: false, $geoip_disable: true }) }));
    expect(mocks.sql.mock.calls[1][0].join('')).toContain('delivered_at = now()');
  });
  it('retains failed events for backoff/retry rather than acknowledging them', async () => {
    mocks.sql.mockResolvedValueOnce([row]).mockResolvedValue([]); mocks.captureImmediate.mockRejectedValue(new Error('offline'));
    await deliverGuestJourneyEvents();
    expect(mocks.sql.mock.calls[1][0].join('')).toContain('next_attempt_at');
    expect(mocks.sql.mock.calls[1][0].join('')).not.toContain('delivered_at = now()');
  });
  it('does not publish staging activity into production analytics', async () => {
    mocks.config.NODE_ENV = 'staging'; await deliverGuestJourneyEvents(); expect(mocks.sql).not.toHaveBeenCalled();
  });
});
