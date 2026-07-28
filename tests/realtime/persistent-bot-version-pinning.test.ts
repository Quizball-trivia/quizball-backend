import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBotModelParams, type BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import { decideMcq, type PersistentBotSkillInputs, type ResolvedQuestionStats } from '../../src/realtime/persistent-bot-gameplay.js';

const params: BotModelParams = parseBotModelParams(
  JSON.parse(readFileSync('/Users/user/dev/quizball/calibration-s1final/params.json', 'utf8')),
);

const inputs: PersistentBotSkillInputs = {
  currentRp: 1200,
  personalOffset: 0.2,
  governorAdjustment: 0,
  categoryAffinities: { football: 0.3 },
  dailyFormSeed: '2026-07-28',
};
const stats: ResolvedQuestionStats = { smoothedAccuracy: 0.55, medianTimeMs: 2500, logTimeSigma: 0.7 };
const keys = { botId: 'bot-9', matchId: 'match-9', questionId: 'q-9' };

describe('version pinning — a mid-match params refresh cannot change a live bot', () => {
  it('decisions depend ONLY on the params object passed in (the pinned copy)', () => {
    // The in-match model reads the params PINNED in ranked_context, not the live
    // active row. Simulate a mid-match refresh by mutating a fresh params object
    // (a different batchId / clamp) and confirm the ORIGINAL pinned params still
    // produce the original decision.
    const pinnedDecision = decideMcq(params, inputs, stats, 'football', keys);

    const refreshed: BotModelParams = parseBotModelParams(
      JSON.parse(readFileSync('/Users/user/dev/quizball/calibration-s1final/params.json', 'utf8')),
    );
    // A refresh would change the batchId (part of the seed) and the clamps.
    (refreshed.source as { batchId: string }).batchId = 'refreshed-batch';
    refreshed.clamps.finalProbCap = 0.5;

    // Using the pinned params again → identical.
    expect(decideMcq(params, inputs, stats, 'football', keys)).toEqual(pinnedDecision);
    // Using the refreshed params → generally different (proves the decision is
    // a pure function of the params handed in, so pinning is what protects the
    // live match).
    const refreshedDecision = decideMcq(refreshed, inputs, stats, 'football', keys);
    expect(refreshedDecision).not.toEqual(pinnedDecision);
  });
});
