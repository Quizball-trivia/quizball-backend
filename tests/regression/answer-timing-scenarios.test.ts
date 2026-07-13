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
  delete process.env.REGRESSION_FAST_TIMERS;
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;

type AnswerRow = {
  time_ms: number;
  points_earned: number;
};

async function waitForAnswer(
  getAnswer: () => Promise<AnswerRow | null>,
  label: string,
  maxMs = 30_000,
): Promise<AnswerRow> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const answer = await getAnswer();
    if (answer) return answer;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describeLocal('regression: answer timing scenarios', () => {
  afterEach(async () => {
    const { teardownRun } = await import('../../game-regression/src/runner.mjs');
    await teardownRun();
  });

  it('persists reveal_ack, client_early, and client_capped timing buckets', { timeout: 420_000 }, async () => {
    const { bootMatch, botForfeit, playMatch } = await import('../../game-regression/src/runner.mjs');
    const { matchAnswersRepo } = await import('../../src/modules/matches/match-answers.repo.js');

    const run = await bootMatch({ startTimeoutMs: 240_000 });
    expect(run.matchId, 'match should boot').toBeTruthy();

    const playing = playMatch(run, {
      maxMs: 120_000,
      answerPlan: {
        0: { emitRevealAckAtMs: 1000, answerAtMs: 1800, timeMs: 800 },
        1: { answerAtMs: -1200, timeMs: 1400 },
        2: { answerAtMs: 4100, timeMs: 900 },
      },
    });

    try {
      const revealAck = await waitForAnswer(
        () => matchAnswersRepo.getAnswerForUser(run.matchId!, 0, run.botUserId),
        'reveal_ack answer',
      );
      expect(revealAck.time_ms, 'reveal_ack stored time_ms').toBeGreaterThanOrEqual(650);
      expect(revealAck.time_ms, 'reveal_ack stored time_ms').toBeLessThanOrEqual(950);
      expect(revealAck.points_earned, 'reveal_ack points').toBe(100);

      const clientEarly = await waitForAnswer(
        () => matchAnswersRepo.getAnswerForUser(run.matchId!, 1, run.botUserId),
        'client_early answer',
      );
      expect(clientEarly.time_ms, 'client_early stored time_ms').toBe(1400);
      expect(clientEarly.points_earned, 'client_early points').toBe(100);

      const clientCapped = await waitForAnswer(
        () => matchAnswersRepo.getAnswerForUser(run.matchId!, 2, run.botUserId),
        'client_capped answer',
      );
      expect(clientCapped.time_ms, 'client_capped stored time_ms').toBe(2400);
      expect(clientCapped.points_earned, 'client_capped points').toBe(90);
    } finally {
      await botForfeit(run).catch(() => {});
      await playing;
    }
  }, 180_000);
});
