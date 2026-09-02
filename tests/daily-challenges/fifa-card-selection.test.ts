import { describe, expect, it } from 'vitest';

import {
  selectDailyFifaCardIds,
  type FifaCardCandidate,
} from '../../src/modules/daily-challenges/fifa-card-selection.js';

const TIERS = ['veryHard', 'hard', 'medium', 'easy'] as const;

/** 4 pre-FIFA20 + 4 recent cards per tier, every card a distinct player. */
function buildPool(): FifaCardCandidate[] {
  const cards: FifaCardCandidate[] = [];
  for (const difficulty of TIERS) {
    for (let i = 0; i < 4; i += 1) {
      cards.push({ id: `${difficulty}-old-${i}`, difficulty, edition: 'FIFA17', name: `${difficulty}-old-player-${i}`, last_served_day: null });
      cards.push({ id: `${difficulty}-new-${i}`, difficulty, edition: 'FC26', name: `${difficulty}-new-player-${i}`, last_served_day: null });
    }
  }
  return cards;
}

const isOld = (edition: string): boolean => Number.parseInt(edition.replace(/[^0-9]/g, ''), 10) < 20;

describe('selectDailyFifaCardIds', () => {
  it('deals 3 veryHard + 3 hard + 4 medium/easy with >=5 pre-FIFA20 and no repeated player', () => {
    const pool = buildPool();
    const byId = new Map(pool.map((card) => [card.id, card]));
    const chosen = selectDailyFifaCardIds(pool, 10, 'rotation-salt', '2026-09-15').map((id) => byId.get(id)!);

    expect(chosen).toHaveLength(10);
    const counts = { easy: 0, medium: 0, hard: 0, veryHard: 0 };
    for (const card of chosen) counts[card.difficulty] += 1;
    expect(counts.veryHard).toBe(3);
    expect(counts.hard).toBe(3);
    expect(counts.medium + counts.easy).toBe(4);
    expect(chosen.filter((card) => isOld(card.edition)).length).toBeGreaterThanOrEqual(5);
    expect(new Set(chosen.map((card) => card.name)).size).toBe(10);
  });

  it('is deterministic per (salt, day) and rotates the set across days', () => {
    const pool = buildPool();
    const first = selectDailyFifaCardIds(pool, 10, 'rotation-salt', '2026-09-15');
    const same = selectDailyFifaCardIds(pool, 10, 'rotation-salt', '2026-09-15');
    const nextDay = selectDailyFifaCardIds(pool, 10, 'rotation-salt', '2026-09-16');

    expect(first).toEqual(same);
    expect(first).not.toEqual(nextDay);
  });

  it('prefers never-served cards over recently-served ones within a tier', () => {
    const pool = buildPool();
    // Of the 4 old veryHard cards, mark 2 as served yesterday. The veryHard old
    // quota (2) should fill from the 2 that are still unseen.
    const oldVeryHard = pool.filter((card) => card.difficulty === 'veryHard' && card.id.startsWith('veryHard-old'));
    oldVeryHard[0].last_served_day = '2026-09-14';
    oldVeryHard[1].last_served_day = '2026-09-14';

    const byId = new Map(pool.map((card) => [card.id, card]));
    const chosenOldVeryHard = selectDailyFifaCardIds(pool, 10, 'rotation-salt', '2026-09-15')
      .map((id) => byId.get(id)!)
      .filter((card) => card.difficulty === 'veryHard' && card.id.startsWith('veryHard-old'));

    expect(chosenOldVeryHard.length).toBeGreaterThan(0);
    expect(chosenOldVeryHard.every((card) => card.last_served_day === null)).toBe(true);
  });
});
