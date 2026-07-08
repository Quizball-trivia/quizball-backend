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
  process.env.FUZZ_ARTIFACT_DIR = 'game-regression/artifacts/phase2-chaos-smoke';
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

describeLocal('regression: phase 2 chaos smoke', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('runs duplicateEmits through the ranked fuzz pipeline', async () => {
    const { runFuzzMatch } = await import('../../game-regression/src/fuzz.mjs');
    const outcome = await runFuzzMatch({
      index: 1,
      mode: 'ranked',
      runTag: 'phase2-duplicate',
      artifactDir: 'game-regression/artifacts/phase2-chaos-smoke',
      playMaxMs: 45_000,
      chaosPlan: {
        seed: 717171,
        actions: [
          { atQIndex: 2, kind: 'duplicateEmits' },
        ],
      },
      writeArtifactOnFailure: true,
    });

    expect(outcome.booted, outcome.error ?? outcome.violations.join('\n')).toBe(true);
    expect(Array.isArray(outcome.economyViolations)).toBe(true);
    if (!outcome.ok) expect(outcome.artifactPath).toBeTruthy();
  }, 180_000);

  it('runs special-phase flap and halftime quit/rejoin targets', async () => {
    const { runFuzzMatch } = await import('../../game-regression/src/fuzz.mjs');
    const outcome = await runFuzzMatch({
      index: 2,
      mode: 'ranked',
      runTag: 'phase2-special',
      artifactDir: 'game-regression/artifacts/phase2-chaos-smoke',
      playMaxMs: 60_000,
      chaosPlan: {
        seed: 727272,
        actions: [
          { atPhase: 'clue_chain', kind: 'flap', params: { n: 1 } },
          { atPhase: 'halftime', kind: 'quitRejoin' },
        ],
      },
      writeArtifactOnFailure: true,
    });

    expect(outcome.booted, outcome.error ?? outcome.violations.join('\n')).toBe(true);
    expect(Array.isArray(outcome.lifecycleViolations)).toBe(true);
    if (!outcome.ok) expect(outcome.artifactPath).toBeTruthy();
  }, 180_000);

  it('runs chaos against friendly possession and party modes', async () => {
    const { runFuzzMatch } = await import('../../game-regression/src/fuzz.mjs');
    const possession = await runFuzzMatch({
      index: 3,
      mode: 'possession',
      runTag: 'phase2-friendly-possession',
      artifactDir: 'game-regression/artifacts/phase2-chaos-smoke',
      playMaxMs: 45_000,
      chaosPlan: {
        seed: 737373,
        actions: [
          { atQIndex: 1, kind: 'flap', params: { n: 1 } },
        ],
      },
      writeArtifactOnFailure: true,
    });
    expect(possession.booted, possession.error ?? possession.violations.join('\n')).toBe(true);

    const party = await runFuzzMatch({
      index: 4,
      mode: 'party',
      runTag: 'phase2-party',
      artifactDir: 'game-regression/artifacts/phase2-chaos-smoke',
      playMaxMs: 45_000,
      chaosPlan: {
        seed: 747474,
        actions: [
          { atQIndex: 1, kind: 'quitRejoin' },
        ],
      },
      writeArtifactOnFailure: true,
    });
    expect(party.booted, party.error ?? party.violations.join('\n')).toBe(true);
  }, 240_000);
});
