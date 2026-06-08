import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the PostHog client so we can assert capture/identify calls.
const captureMock = vi.fn();
const identifyMock = vi.fn();
const shutdownMock = vi.fn(() => Promise.resolve());
vi.mock('posthog-node', () => ({
  PostHog: vi.fn().mockImplementation(() => ({
    capture: (...a: unknown[]) => captureMock(...a),
    identify: (...a: unknown[]) => identifyMock(...a),
    alias: vi.fn(),
    shutdown: (...a: unknown[]) => shutdownMock(...a),
  })),
}));

// Mock the DB. `sql\`...\`` is a tagged template: first arg is the strings
// array, rest are interpolated values. We resolve based on the queried user id
// and count calls so tests can assert when a lookup did/didn't happen.
const sqlResultByUserId = new Map<string, { is_ai: boolean }[]>();
let sqlShouldThrow = false;
const sqlCallSpy = vi.fn();
// When set, the is_ai lookup does NOT resolve until the test calls the captured
// release fn — lets us hold a capture in-flight while shutdown is requested.
let sqlGate: { release: () => void } | null = null;
vi.mock('../../src/db/index.js', () => ({
  sql: (_strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCallSpy(String(values[0]));
    if (sqlShouldThrow) return Promise.reject(new Error('db down'));
    const userId = String(values[0]);
    const rows = sqlResultByUserId.get(userId) ?? [];
    if (sqlGate) {
      return new Promise((resolve) => {
        sqlGate = { release: () => resolve(rows) };
      });
    }
    return Promise.resolve(rows);
  },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const REAL_USER = '11111111-1111-4111-8111-111111111111';
const AI_USER = '22222222-2222-4222-8222-222222222222';
const ANON_WEB_ID = 'anon-session-abc123'; // NOT a user UUID — must skip the DB lookup entirely

let trackEvent: typeof import('../../src/core/analytics.js').trackEvent;
let identifyUser: typeof import('../../src/core/analytics.js').identifyUser;
let identifyUserProfile: typeof import('../../src/core/analytics.js').identifyUserProfile;
let registerAiUserId: typeof import('../../src/core/analytics.js').registerAiUserId;
let shutdownPostHog: typeof import('../../src/core/analytics.js').shutdownPostHog;

beforeEach(async () => {
  vi.resetModules();
  captureMock.mockClear();
  identifyMock.mockClear();
  shutdownMock.mockClear();
  sqlResultByUserId.clear();
  sqlCallSpy.mockClear();
  sqlShouldThrow = false;
  sqlGate = null;
  sqlResultByUserId.set(REAL_USER, [{ is_ai: false }]);
  sqlResultByUserId.set(AI_USER, [{ is_ai: true }]);
  process.env.POSTHOG_API_KEY = 'test-key';
  const mod = await import('../../src/core/analytics.js');
  trackEvent = mod.trackEvent;
  identifyUser = mod.identifyUser;
  identifyUserProfile = mod.identifyUserProfile;
  registerAiUserId = mod.registerAiUserId;
  shutdownPostHog = mod.shutdownPostHog;
});

afterEach(() => {
  delete process.env.POSTHOG_API_KEY;
});

// trackEvent/identifyUser are fire-and-forget; let the internal async guard settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('analytics AI-user suppression', () => {
  it('captures events for real (is_ai=false) users', async () => {
    trackEvent('match_completed', REAL_USER, { mode: 'possession' });
    await flush();
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls[0][0].distinctId).toBe(REAL_USER);
  });

  it('suppresses events for AI (is_ai=true) users', async () => {
    trackEvent('match_completed', AI_USER, { mode: 'possession' });
    await flush();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('suppresses identify for AI users but allows real users', async () => {
    identifyUser(AI_USER, { email: 'x' });
    identifyUser(REAL_USER, { email: 'real@example.com' });
    await flush();
    expect(identifyMock).toHaveBeenCalledTimes(1);
    expect(identifyMock.mock.calls[0][0].distinctId).toBe(REAL_USER);
  });

  it('identifies user profiles with PostHog display properties', async () => {
    identifyUserProfile({
      id: REAL_USER,
      email: 'real@example.com',
      nickname: null,
      created_at: '2026-06-07T00:00:00.000Z',
    });
    await flush();

    expect(identifyMock).toHaveBeenCalledWith({
      distinctId: REAL_USER,
      properties: expect.objectContaining({
        $email: 'real@example.com',
        $name: 'real@example.com',
        email: 'real@example.com',
        name: 'real@example.com',
        created_at: '2026-06-07T00:00:00.000Z',
      }),
    });
  });

  it('treats non-user-UUID distinct ids (anon web sessions) as non-AI without a DB lookup', async () => {
    trackEvent('$pageview', ANON_WEB_ID);
    await flush();
    expect(captureMock).toHaveBeenCalledTimes(1);
    // The key assertion: a non-UUID distinctId must NOT trigger a DB lookup.
    expect(sqlCallSpy).not.toHaveBeenCalled();
  });

  it('uses the captured occurredAt timestamp, not the post-lookup time', async () => {
    trackEvent('match_completed', REAL_USER);
    await flush();
    const ts = captureMock.mock.calls[0][0].properties.$timestamp;
    // Stamped at call time; within a couple seconds of now (not skewed by lookup latency).
    expect(Math.abs(Date.now() - new Date(ts).getTime())).toBeLessThan(2000);
  });

  it('fails OPEN: captures the event if the DB lookup throws', async () => {
    sqlShouldThrow = true;
    trackEvent('match_completed', REAL_USER);
    await flush();
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('registerAiUserId warms the cache so a later event is suppressed with no DB row', async () => {
    // No DB row for this id; registration alone must suppress it.
    const freshAi = '33333333-3333-4333-8333-333333333333';
    registerAiUserId(freshAi);
    trackEvent('match_completed', freshAi);
    await flush();
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe('analytics shutdown drains pending captures', () => {
  it('shutdownPostHog waits for an in-flight capture (behind a slow is_ai lookup) before closing the client', async () => {
    // Arm the gate so the is_ai lookup hangs until we release it. This simulates
    // an event fired moments before shutdown whose AI check is still running.
    sqlGate = { release: () => {} };
    trackEvent('match_completed', REAL_USER, { mode: 'possession' });

    // The lookup is started but blocked: nothing captured yet.
    await flush();
    expect(sqlCallSpy).toHaveBeenCalledTimes(1);
    expect(captureMock).not.toHaveBeenCalled();

    // Request shutdown WITHOUT awaiting. It must NOT resolve while the deferred
    // capture is still pending — otherwise the event is lost.
    let shutdownResolved = false;
    const shutdownPromise = shutdownPostHog().then(() => {
      shutdownResolved = true;
    });
    await flush();
    expect(shutdownResolved, 'shutdown must block on the pending capture').toBe(false);
    expect(shutdownMock, 'client.shutdown must not be called while a capture is pending').not.toHaveBeenCalled();

    // Release the lookup → the deferred capture runs, THEN shutdown completes.
    sqlGate!.release();
    await shutdownPromise;

    expect(shutdownResolved).toBe(true);
    expect(captureMock, 'the event must be captured before the client closes').toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls[0][0].distinctId).toBe(REAL_USER);
    // Ordering: the capture happened, and only then did the client shut down.
    const captureOrder = captureMock.mock.invocationCallOrder[0];
    const shutdownOrder = shutdownMock.mock.invocationCallOrder[0];
    expect(captureOrder).toBeLessThan(shutdownOrder);
  });

  it('shutdownPostHog resolves cleanly when all captures have already settled', async () => {
    // Initialize the client and let the (ungated) capture fully settle first.
    trackEvent('match_completed', REAL_USER);
    await flush();
    expect(captureMock).toHaveBeenCalledTimes(1);

    await shutdownPostHog();
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });
});
