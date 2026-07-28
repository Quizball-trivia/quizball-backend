import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBotModelParams, type BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import { decideMcq, type PersistentBotSkillInputs, type ResolvedQuestionStats } from '../../src/realtime/persistent-bot-gameplay.js';

const params: BotModelParams = parseBotModelParams(
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures/params.json'), 'utf8')),
);

const inputs: PersistentBotSkillInputs = {
  currentRp: 1200,
  personalOffset: 0.2,
  governorAdjustment: 0,
  categoryAffinities: { football: 0.3 },
  dailyFormSeed: '2026-07-28',
  thetaCeilingBound: 2.5,
};
const stats: ResolvedQuestionStats = { smoothedAccuracy: 0.55, medianTimeMs: 2500, logTimeSigma: 0.7 };
const keys = { botId: 'bot-9', matchId: 'match-9', questionId: 'q-9' };

describe('version pinning — a mid-match params refresh cannot change a live bot', () => {
  it('decisions depend ONLY on the params object passed in (the pinned copy)', () => {
    // The in-match model reads the params PINNED in ranked_context, not the live
    // active row. Simulate a mid-match refresh by mutating a fresh params object
    // (a different batchId / clamp) and confirm the ORIGINAL pinned params still
    // produce the original decision.
    // The pinned params ALWAYS reproduce the identical decision (the core
    // immutability invariant): this is fully deterministic, never flaky.
    const pinnedDecision = decideMcq(params, inputs, stats, 'football', keys);
    expect(decideMcq(params, inputs, stats, 'football', keys)).toEqual(pinnedDecision);

    // And the decision is governed ONLY by the params object handed in — a
    // refresh that lowered the prob cap would clamp pCorrect to that lower cap.
    // Use an easy question + strong bot so the cap is the BINDING constraint,
    // giving a DETERMINISTIC difference (not a coincidence-prone inequality).
    const refreshed: BotModelParams = parseBotModelParams(
      JSON.parse(readFileSync(resolve(__dirname, 'fixtures/params.json'), 'utf8')),
    );
    // 0.7 is < HARD_PROB_CAP 0.93 so it passes the schema; it only tightens.
    refreshed.clamps.finalProbCap = 0.7;
    const strongOnEasy: PersistentBotSkillInputs = { ...inputs, currentRp: 9000, personalOffset: 0.9 };
    const easyStats: ResolvedQuestionStats = { smoothedAccuracy: 0.95, medianTimeMs: 2000, logTimeSigma: 0.6 };

    const pinnedP = decideMcq(params, strongOnEasy, easyStats, 'football', keys).pCorrect;
    const refreshedP = decideMcq(refreshed, strongOnEasy, easyStats, 'football', keys).pCorrect;
    // The pinned params allow up to 0.93; the refreshed clamp caps at 0.7. On an
    // easy question a strong bot's raw p exceeds 0.7, so the caps bind differently.
    expect(pinnedP).toBeGreaterThan(0.7);
    expect(refreshedP).toBeLessThanOrEqual(0.7 + 1e-9);
    expect(refreshedP).toBeLessThan(pinnedP);
  });
});
