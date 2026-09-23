import { beforeEach, describe, expect, it, vi } from 'vitest';

const { captureImmediate, query, config } = vi.hoisted(() => ({
  captureImmediate: vi.fn(async () => undefined),
  query: vi.fn(async (_statement: string) => [{ registered_members: 6948 }]),
  config: { NODE_ENV: 'prod' },
}));

vi.mock('../../src/core/analytics.js', () => ({
  getPostHogClient: () => ({ captureImmediate }),
  stableAnalyticsEventUuid: (key: string) => `stable:${key}`,
}));
vi.mock('../../src/core/config.js', () => ({ config }));
vi.mock('../../src/core/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../../src/db/index.js', () => ({ sql: (parts: TemplateStringsArray) => query(parts.join('')) }));

import { publishRegisteredMemberCountSnapshot } from '../../src/modules/analytics/registered-members.worker.js';

describe('registered-member count snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.NODE_ENV = 'prod';
  });

  it('counts only real, non-deleted members and sends an anonymous, retry-safe snapshot', async () => {
    await publishRegisteredMemberCountSnapshot(new Date('2026-09-23T09:23:26.000Z'));

    expect(query).toHaveBeenCalledOnce();
    const statement = query.mock.calls[0]![0];
    for (const predicate of ['is_ai', 'is_seed', 'is_guest', 'is_deleted', 'deleted_at IS NULL']) {
      expect(statement).toContain(predicate);
    }
    expect(captureImmediate).toHaveBeenCalledWith(expect.objectContaining({
      distinctId: 'quizball:registered-member-count',
      event: 'registered_member_count_snapshot',
      uuid: 'stable:registered-member-count:2026-09-23T09:20:00.000Z',
      timestamp: new Date('2026-09-23T09:20:00.000Z'),
      properties: expect.objectContaining({
        registered_members: 6948,
        $process_person_profile: false,
        environment: 'prod',
      }),
    }));
  });

  it('does not query or emit a count in local development', async () => {
    config.NODE_ENV = 'local';
    await publishRegisteredMemberCountSnapshot();
    expect(query).not.toHaveBeenCalled();
    expect(captureImmediate).not.toHaveBeenCalled();
  });

  it('routes staging snapshots only to staging analytics', async () => {
    config.NODE_ENV = 'staging';
    await publishRegisteredMemberCountSnapshot(new Date('2026-09-23T09:23:26.000Z'));
    expect(captureImmediate).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({ source: 'staging.users', environment: 'staging' }),
    }));
  });
});
