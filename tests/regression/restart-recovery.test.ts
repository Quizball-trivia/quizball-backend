import { afterEach, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const LOCAL_REDIS = process.env.REGRESSION_REDIS_URL ?? 'redis://localhost:6379/15';
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
  process.env.REDIS_URL = LOCAL_REDIS;
  process.env.RANKED_HUMAN_QUEUE_ENABLED = 'true';
  process.env.REGRESSION_DETERMINISTIC = '1';
  process.env.REGRESSION_FAST_TIMERS = '1';
  process.env.FUZZ_ARTIFACT_DIR = 'game-regression/artifacts/restart-recovery';
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: engine restart recovery chaos', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('runs an engineRestart chaos action through the fuzz pipeline', async () => {
    const { runFuzzMatch } = await import('../../game-regression/src/fuzz.mjs');
    const outcome = await runFuzzMatch({
      index: 1,
      mode: 'ranked',
      runTag: 'restart-recovery',
      artifactDir: 'game-regression/artifacts/restart-recovery',
      playMaxMs: 45_000,
      chaosPlan: {
        seed: 626262,
        actions: [
          { atQIndex: 2, kind: 'engineRestart' },
        ],
      },
      writeArtifactOnFailure: true,
    });

    expect(outcome.booted, outcome.error ?? outcome.violations.join('\n')).toBe(true);
    expect(Array.isArray(outcome.lifecycleViolations)).toBe(true);
    expect(Array.isArray(outcome.clientTruthViolations)).toBe(true);
    expect(Array.isArray(outcome.economyViolations)).toBe(true);
    if (!outcome.ok) expect(outcome.artifactPath).toBeTruthy();
  }, 180_000);

  it('can restart while a disconnect-grace marker is in flight', async () => {
    const { bootMatch, botDisconnect, engineRestart, playMatch } = await import('../../game-regression/src/runner.mjs');
    const { sql } = await import('../../src/db/index.js');

    const run = await bootMatch({ startTimeoutMs: 25_000 });
    expect(run.matchId).toBeTruthy();

    await botDisconnect(run);
    await engineRestart(run);
    await playMatch(run, { maxMs: 35_000 });

    const [match] = await sql<Array<{ status: string }>>`
      SELECT status FROM matches WHERE id = ${run.matchId}
    `;
    expect(match?.status).toBeTruthy();
  }, 180_000);
});
