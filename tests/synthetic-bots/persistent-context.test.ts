/**
 * Unit tests for the persistent-bot ranked context (PR7 §1.7 difficulty bridge):
 *   - carries NO aiAnchorRp (settlement/payloads read the real profile, PR3)
 *   - correctness derived from the bot's RP, clamped ≤ 0.75 (bridge until PR8)
 *   - delay profile derived from the bot's RP
 * Pure functions — no DB.
 */
import { describe, it, expect } from 'vitest';
import '../setup.js';
import { rankedService, correctnessFromAnchor } from '../../src/modules/ranked/ranked.service.js';

describe('buildPersistentBotMatchContext (difficulty bridge)', () => {
  it('never includes aiAnchorRp', () => {
    const ctx = rankedService.buildPersistentBotMatchContext(2400);
    expect('aiAnchorRp' in ctx).toBe(false);
  });

  it('derives correctness from the bot RP and clamps ≤ 0.75', () => {
    const low = rankedService.buildPersistentBotMatchContext(150);
    const high = rankedService.buildPersistentBotMatchContext(9000);
    expect(high.aiCorrectness).toBeLessThanOrEqual(0.75);
    expect(low.aiCorrectness).toBeGreaterThanOrEqual(0.35);
    expect(high.aiCorrectness).toBeGreaterThan(low.aiCorrectness);
    // matches the shared ephemeral helper for an in-range anchor
    expect(rankedService.buildPersistentBotMatchContext(1200).aiCorrectness).toBeCloseTo(
      correctnessFromAnchor(1200),
      5,
    );
  });

  it('provides a valid delay profile (minMs ≤ maxMs)', () => {
    const ctx = rankedService.buildPersistentBotMatchContext(1800);
    expect(ctx.aiDelayProfile.minMs).toBeLessThanOrEqual(ctx.aiDelayProfile.maxMs);
    expect(ctx.aiDelayProfile.minMs).toBeGreaterThan(0);
  });
});
