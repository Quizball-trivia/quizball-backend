/**
 * Friendly party-quiz lobby scenario. A DIFFERENT match engine from possession:
 * MCQ-only, simultaneous answering, standings/leaderboard instead of possession
 * bars/phases. Drives the real lobby path with the party variant
 * (createLobby -> joinByCode -> updateSettings(friendly_party_quiz) -> ready ->
 * start) and plays all seats to completion.
 *
 * Uses the PARTY-specific referee (game-regression/src/party-invariants.mts), since
 * the possession invariants (bars/phases/question-counter) don't apply. Checks:
 * scores monotonic, ranking coherent, one question per qIndex, terminal reached,
 * final standings well-formed. Plus the shared post-match DB checks.
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
process.env.LOG_LEVEL = 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: friendly party-quiz lobby', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('lobby party-quiz (2 players) plays to completion with coherent standings', async () => {
    const { bootFriendlyLobbyMatch, playLobbyMatch } = await import('../../game-regression/src/runner.mjs');
    const { checkPartyInvariants } = await import('../../game-regression/src/party-invariants.mjs');
    const { formatViolation } = await import('../../game-regression/src/invariants.mjs');
    const { checkPostMatchState, formatPostMatchViolation } = await import('../../game-regression/src/post-match.mjs');

    const run = await bootFriendlyLobbyMatch({ variant: 'friendly_party_quiz', startTimeoutMs: 25_000 });

    expect(run.lobbyId, 'lobby should be created').toBeTruthy();
    expect(run.matchId, 'host start should produce a match').toBeTruthy();
    const startEvt = run.trace.byEvent('match:start')[0]?.payload as { variant?: string } | undefined;
    expect(startEvt?.variant, 'match should be friendly_party_quiz').toBe('friendly_party_quiz');

    // Party quiz emits match:party_state — confirm the engine actually ran as party.
    expect(
      run.trace.byEvent('match:party_state').length,
      'party quiz should emit party_state',
    ).toBeGreaterThan(0);

    await playLobbyMatch(run, { maxMs: 90_000 });

    expect(
      run.trace.byEvent('match:final_results').length,
      'party-quiz match should complete',
    ).toBeGreaterThan(0);

    const inv = checkPartyInvariants(run.trace);
    if (!inv.ok) console.error('Party invariant violations:\n' + inv.violations.map(formatViolation).join('\n'));
    expect(inv.ok, 'all party-quiz invariants should hold').toBe(true);

    await new Promise((r) => setTimeout(r, 1_500));
    const post = await checkPostMatchState(run.matchId!);
    if (!post.ok) console.error('Post-match violations:\n' + post.violations.map(formatPostMatchViolation).join('\n'));
    console.info('Party post-match facts:', JSON.stringify(post.facts));
    expect(post.ok, 'post-match state should be coherent for a party match').toBe(true);
  }, 150_000);
});
