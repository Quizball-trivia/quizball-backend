/**
 * Friendly possession (human-vs-human) lobby scenario. Exercises the REAL lobby
 * entry path the ranked-AI scenarios skip: createLobby -> joinByCode -> ready ->
 * startFriendlyMatch -> beginMatchForLobby -> a friendly_possession match with TWO
 * human seats (no AI). Both seats play to completion; the SAME possession invariants
 * must hold (the referee is mode-agnostic for possession), and the post-match
 * pipeline must run (completed + per-player totals; friendly => no ranked RP).
 *
 * Local-only: opt in with REGRESSION_DB_URL pointing at the native local DB.
 */
import { afterEach, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const LOCAL_REDIS = process.env.REGRESSION_REDIS_URL ?? 'redis://:changeme@localhost:6379/15';
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
  process.env.REDIS_URL = LOCAL_REDIS;
  process.env.RANKED_HUMAN_QUEUE_ENABLED = 'true';
  process.env.REGRESSION_DETERMINISTIC = '1';
  process.env.REGRESSION_FAST_TIMERS = '1';
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: friendly possession lobby (human-vs-human)', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('create -> join by code -> ready -> host start -> 2-human possession match completes, invariants hold', async () => {
    const { bootFriendlyLobbyMatch, playLobbyMatch } = await import('../../game-regression/src/runner.mjs');
    const { checkInvariants, formatViolation } = await import('../../game-regression/src/invariants.mjs');
    const { checkPostMatchState, formatPostMatchViolation } = await import('../../game-regression/src/post-match.mjs');

    const run = await bootFriendlyLobbyMatch({ variant: 'friendly_possession', startTimeoutMs: 25_000 });

    // The lobby flow produced a lobby + an invite code + a started match.
    expect(run.lobbyId, 'lobby should be created').toBeTruthy();
    expect(run.inviteCode, 'lobby should have an invite code').toBeTruthy();
    expect(run.matchId, 'host start should produce a match').toBeTruthy();

    // It started as friendly_possession (the variant set via updateSettings).
    const startEvt = run.trace.byEvent('match:start')[0]?.payload as { variant?: string } | undefined;
    expect(startEvt?.variant, 'match should be friendly_possession').toBe('friendly_possession');

    await playLobbyMatch(run, { maxMs: 90_000 });

    expect(
      run.trace.byEvent('match:final_results').length,
      'friendly match should complete',
    ).toBeGreaterThan(0);

    const inv = checkInvariants(run.trace);
    if (!inv.ok) console.error('Invariant violations:\n' + inv.violations.map(formatViolation).join('\n'));
    expect(inv.ok, 'all invariants should hold for a friendly possession match').toBe(true);

    // Post-match: completed + per-player totals. Friendly is NOT ranked, so the
    // ranked-only checks are skipped by checkPostMatchState (mode != 'ranked').
    await new Promise((r) => setTimeout(r, 1_500));
    const post = await checkPostMatchState(run.matchId!);
    if (!post.ok) console.error('Post-match violations:\n' + post.violations.map(formatPostMatchViolation).join('\n'));
    console.info('Friendly post-match facts:', JSON.stringify(post.facts));
    expect(post.ok, 'post-match state should be coherent for a friendly match').toBe(true);
  }, 150_000);
});
