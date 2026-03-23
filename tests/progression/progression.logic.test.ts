import { describe, expect, it } from 'vitest';

import {
  getMatchXpReward,
  getProgressionFromTotalXp,
  xpRequiredForLevel,
} from '../../src/modules/progression/progression.logic.js';

describe('progression.logic', () => {
  it('returns level 1 progression for zero XP', () => {
    expect(getProgressionFromTotalXp(0)).toEqual({
      level: 1,
      totalXp: 0,
      currentLevelXp: 0,
      xpForNextLevel: 100,
      progressPct: 0,
    });
  });

  it('advances exactly at a level threshold', () => {
    expect(getProgressionFromTotalXp(100)).toEqual({
      level: 2,
      totalXp: 100,
      currentLevelXp: 0,
      xpForNextLevel: 112,
      progressPct: 0,
    });
  });

  it('handles multi-level progression from one total XP value', () => {
    expect(getProgressionFromTotalXp(250)).toEqual({
      level: 3,
      totalXp: 250,
      currentLevelXp: 38,
      xpForNextLevel: 125,
      progressPct: 30,
    });
  });

  it('remains stable for large XP totals', () => {
    const progression = getProgressionFromTotalXp(100_000);

    expect(progression.totalXp).toBe(100_000);
    expect(progression.level).toBeGreaterThan(1);
    expect(progression.currentLevelXp).toBeGreaterThanOrEqual(0);
    expect(progression.currentLevelXp).toBeLessThan(progression.xpForNextLevel);
    expect(progression.progressPct).toBeGreaterThanOrEqual(0);
    expect(progression.progressPct).toBeLessThanOrEqual(100);
  });

  it('uses the configured level curve', () => {
    expect(xpRequiredForLevel(1)).toBe(100);
    expect(xpRequiredForLevel(2)).toBe(112);
    expect(xpRequiredForLevel(3)).toBe(125);
  });

  it('returns correct match XP for all mode/result combinations', () => {
    expect(getMatchXpReward({ mode: 'ranked', result: 'win' })).toBe(120);
    expect(getMatchXpReward({ mode: 'ranked', result: 'draw' })).toBe(100);
    expect(getMatchXpReward({ mode: 'ranked', result: 'loss' })).toBe(85);
    expect(getMatchXpReward({ mode: 'ranked', result: 'loss', isForfeitLoss: true })).toBe(40);
    expect(getMatchXpReward({ mode: 'friendly', result: 'win' })).toBe(70);
    expect(getMatchXpReward({ mode: 'friendly', result: 'draw' })).toBe(60);
    expect(getMatchXpReward({ mode: 'friendly', result: 'loss' })).toBe(50);
    expect(getMatchXpReward({ mode: 'friendly', result: 'loss', isForfeitLoss: true })).toBe(20);
  });
});
