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
  process.env.FUZZ_ARTIFACT_DIR = 'game-regression/artifacts/boot-chaos-smoke';
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: boot-stage chaos smoke', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('runs a kickoff-gate flap through the fuzz pipeline', async () => {
    const { runFuzzMatch } = await import('../../game-regression/src/fuzz.mjs');
    const outcome = await runFuzzMatch({
      index: 1,
      mode: 'ranked',
      runTag: 'boot-chaos-smoke',
      artifactDir: 'game-regression/artifacts/boot-chaos-smoke',
      playMaxMs: 45_000,
      chaosPlan: {
        seed: 515151,
        actions: [
          { atQIndex: 0, kind: 'flapAtKickoffGate', params: { reconnectDelayMs: 75, mode: 'blind' } },
        ],
      },
      writeArtifactOnFailure: true,
    });

    expect(outcome.booted, outcome.error ?? outcome.violations.join('\n')).toBe(true);
    expect(Array.isArray(outcome.violations)).toBe(true);
    expect(Array.isArray(outcome.traceViolations)).toBe(true);
    expect(Array.isArray(outcome.lifecycleViolations)).toBe(true);
    if (!outcome.ok) expect(outcome.artifactPath).toBeTruthy();
  }, 180_000);
});
