import { describe, expect, it } from 'vitest';
import '../setup.js';

import { AUCTION_BOT_SKILL_CAP,
  fabricatedAuctionBotProfile,
} from '../../src/realtime/services/auction-bot-selection.service.js';
import { resolveAuctionBotBehaviour } from '../../src/realtime/services/auction-bot-profile.js';

describe('ephemeral Auction bot personalities', () => {
  it('keeps a nickname personality stable across matches', () => {
    expect(fabricatedAuctionBotProfile('tengo')).toEqual(fabricatedAuctionBotProfile('tengo'));
  });

  it('gives fallback bots different skill, consistency and behavioural styles', () => {
    const names = ['tengo', 'lukaberidze', 'futbolmaster', 'datuna', 'nika'];
    const profiles = names.map(fabricatedAuctionBotProfile);
    const behaviours = profiles.map(resolveAuctionBotBehaviour);

    expect(new Set(profiles.map((profile) => profile.baseSkill)).size).toBeGreaterThan(1);
    expect(new Set(profiles.map((profile) => profile.consistency)).size).toBeGreaterThan(1);
    expect(new Set(behaviours.map((behaviour) => behaviour.jumpThreshold)).size).toBeGreaterThan(1);
    expect(new Set(behaviours.map((behaviour) => behaviour.budgetDiscipline)).size).toBeGreaterThan(1);
    expect(new Set(behaviours.map((behaviour) => behaviour.chemWeight)).size).toBeGreaterThan(1);
  });

  it('keeps generated traits inside the supported profile range', () => {
    for (const name of ['tengo', 'lukaberidze', 'futbolmaster', 'datuna', 'nika']) {
      const profile = fabricatedAuctionBotProfile(name);
      expect(profile.baseSkill).toBeGreaterThanOrEqual(0.15);
      // Sim-tuned auction cap: uncapped skill farms casual players.
      expect(profile.baseSkill).toBeLessThanOrEqual(AUCTION_BOT_SKILL_CAP);
      expect(profile.consistency).toBeGreaterThanOrEqual(0.2);
      expect(profile.consistency).toBeLessThanOrEqual(0.9);
      expect(profile.personalitySeed).toBeGreaterThan(0);
    }
  });
});
