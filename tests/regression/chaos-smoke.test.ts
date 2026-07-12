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
  process.env.FUZZ_ARTIFACT_DIR = 'game-regression/artifacts/chaos-smoke';
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: chaos fuzzer smoke', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('runs one fixed chaos plan through the fuzz pipeline', async () => {
    const { runFuzzMatch } = await import('../../game-regression/src/fuzz.mjs');
    const outcome = await runFuzzMatch({
      index: 1,
      mode: 'ranked',
      runTag: 'chaos-smoke',
      artifactDir: 'game-regression/artifacts/chaos-smoke',
      chaosPlan: {
        seed: 424242,
        actions: [
          { atQIndex: 2, kind: 'flap', params: { n: 1 } },
          { atQIndex: 4, kind: 'staleDisconnect' },
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
