import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generateRankedAiUsernameAvoiding,
  getAiNicknamePool,
} from '../../src/realtime/ai-ranked.constants.js';

describe('generateRankedAiUsernameAvoiding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('can pick beaborjgali or leaborjgali when only seed-blocked names are in taken set', () => {
    const pool = getAiNicknamePool();
    const taken = new Set(
      pool
        .filter((name) => name !== 'beaborjgali' && name !== 'leaborjgali')
        .map((name) => name.toLowerCase())
    );

    const available = pool.filter((name) => !taken.has(name.toLowerCase()));
    expect(available).toEqual(expect.arrayContaining(['beaborjgali', 'leaborjgali']));

    vi.spyOn(Math, 'random').mockReturnValue(0);
    const firstPick = generateRankedAiUsernameAvoiding(taken);
    expect(available).toContain(firstPick);

    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const lastPick = generateRankedAiUsernameAvoiding(taken);
    expect(available).toContain(lastPick);
  });

  it('suffixes when every pool nickname is taken by real users', () => {
    const pool = getAiNicknamePool();
    const taken = new Set(pool.map((name) => name.toLowerCase()));

    vi.spyOn(Math, 'random').mockReturnValue(0);
    const username = generateRankedAiUsernameAvoiding(taken);
    expect(username).toMatch(/^.+_\d{4}$/);
    expect(pool.some((name) => username.startsWith(name))).toBe(true);
  });
});
