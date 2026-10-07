import { beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => vi.fn());
const captureImmediate = vi.hoisted(() => vi.fn(async () => undefined));
const identify = vi.hoisted(() => vi.fn());
vi.mock('posthog-node', () => ({
  PostHog: vi.fn().mockImplementation(() => ({ capture, captureImmediate, identify, shutdown: vi.fn(async () => undefined) })),
}));

const db = vi.hoisted(() => ({ rows: new Map<string, unknown[]>(), statements: [] as string[], snapshot: [] as unknown[] }));
vi.mock('../../src/db/index.js', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    db.statements.push(text);
    if (text.includes('registered_members')) return Promise.resolve(db.snapshot);
    return Promise.resolve(db.rows.get(String(values[0])) ?? []);
  },
}));
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const config = vi.hoisted(() => ({ NODE_ENV: 'prod' }));
vi.mock('../../src/core/config.js', () => ({ config }));

const MEMBER = '11111111-1111-4111-8111-111111111111';
const PARTNER = '33333333-3333-4333-8333-333333333333';
const STAFF = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.POSTHOG_API_KEY = 'test-key';
  db.statements.length = 0;
  db.rows.set(MEMBER, [{ is_ai: false, is_guest: false, partner_slug: null, role: 'user' }]);
  db.rows.set(PARTNER, [{ is_ai: false, is_guest: false, partner_slug: 'freecroco', role: 'user' }]);
  db.rows.set(STAFF, [{ is_ai: false, is_guest: false, partner_slug: null, role: 'partner_staff' }]);
});

describe('analytics tags partner rows instead of dropping them', () => {
  it('a partner player event is kept, tagged partner + partner_slug, and creates no person', async () => {
    const { trackEvent, identifyUser, shutdownPostHog } = await import('../../src/core/analytics.js');
    trackEvent('match_finished', PARTNER, {});
    trackEvent('match_finished', MEMBER, {});
    trackEvent('match_finished', STAFF, {});
    identifyUser(PARTNER, { nickname: 'x' });
    identifyUser(STAFF, { nickname: 'x' });
    await shutdownPostHog();
    const props = (id: string) => capture.mock.calls.map((c) => c[0]).find((e) => e.distinctId === id)?.properties;
    expect(props(PARTNER)).toMatchObject({ access_type: 'partner', partner_slug: 'freecroco', $process_person_profile: false });
    expect(props(STAFF)).toMatchObject({ access_type: 'staff', $process_person_profile: false });
    expect(props(MEMBER)).toMatchObject({ access_type: 'member' });
    expect(props(MEMBER)).not.toHaveProperty('partner_slug');
    expect(identify).not.toHaveBeenCalled();
  });
});

describe('registered-member snapshot', () => {
  it('keeps members-only counts free of partner rows and reports partner players beside them', async () => {
    db.snapshot = [{ registered_members: 7000, partner_players: 120, partner_players_by_partner: { freecroco: 120 } }];
    const { publishRegisteredMemberCountSnapshot } = await import('../../src/modules/analytics/registered-members.worker.js');
    await publishRegisteredMemberCountSnapshot(new Date('2026-10-05T10:00:00Z'));
    const statement = db.statements.find((s) => s.includes('registered_members'))!;
    expect(statement).toContain("partner_slug IS NULL AND role <> 'partner_staff'");
    expect(captureImmediate).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({
        registered_members: 7000,
        partner_players: 120,
        partner_players_by_partner: { freecroco: 120 },
        users_including_partners: 7120,
      }),
    }));
  });
});
