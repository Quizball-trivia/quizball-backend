import { describe, expect, it } from 'vitest';
import {
  ROAD_TO_GOAL_DIFFICULTIES,
  ROAD_TO_GOAL_MULTIPLIERS_BP,
  ROAD_TO_GOAL_STAKES,
  ROAD_TO_GOAL_ZONES,
  multiplierBpForClearedZones,
  payoutForClearedZones,
  payoutMinorForClearedZones,
} from '../../src/modules/road-to-goal/road-to-goal.constants.js';
import { buildRoadToGoalQuestionSet } from '../../src/modules/road-to-goal/road-to-goal.questions.js';
import type {
  RoadToGoalDifficulty,
  RoadToGoalQuestionCandidate,
} from '../../src/modules/road-to-goal/road-to-goal.types.js';

function candidate(id: number, difficulty: RoadToGoalDifficulty): RoadToGoalQuestionCandidate {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    difficulty,
    prompt: { en: `Question ${id}`, ka: `კითხვა ${id}` },
    payload: {
      type: 'mcq_single',
      options: [0, 1, 2, 3].map((option) => ({
        id: `option-${id}-${option}`,
        text: { en: `Option ${option}`, ka: `პასუხი ${option}` },
        is_correct: option === 2,
      })),
    },
  };
}

describe('Road to Goal rules', () => {
  it('has one multiplier and one difficulty for every zone', () => {
    expect(ROAD_TO_GOAL_MULTIPLIERS_BP).toHaveLength(ROAD_TO_GOAL_ZONES);
    expect(ROAD_TO_GOAL_DIFFICULTIES).toHaveLength(ROAD_TO_GOAL_ZONES);
    expect(ROAD_TO_GOAL_MULTIPLIERS_BP).toEqual([...ROAD_TO_GOAL_MULTIPLIERS_BP].sort((a, b) => a - b));
  });

  it('settles the multiplier ladder to exact hundredths', () => {
    expect(payoutForClearedZones(25, 0)).toBe(25);
    expect(payoutForClearedZones(25, 1)).toBe(25.75);
    expect(payoutForClearedZones(25, 8)).toBe(49.5);
    expect(payoutForClearedZones(25, 11)).toBe(100);
    expect(multiplierBpForClearedZones(11)).toBe(40_000);
  });

  it('keeps payout math exact and bounded for every stake and zone', () => {
    for (const stake of ROAD_TO_GOAL_STAKES) {
      const payouts = Array.from({ length: ROAD_TO_GOAL_ZONES + 1 }, (_, zone) => {
        const multiplier = multiplierBpForClearedZones(zone);
        const expected = (stake * multiplier) / 10_000;
        expect(payoutForClearedZones(stake, zone)).toBe(expected);
        expect(payoutMinorForClearedZones(stake, zone)).toBe(expected * 100);
        return expected;
      });
      expect(payouts).toEqual([...payouts].sort((left, right) => left - right));
      expect(payouts.at(-1)).toBeLessThanOrEqual(200);
    }
  });

  it('builds an 11-question easy/medium/hard run without leaking correctness into options', () => {
    const candidates = [
      ...Array.from({ length: 6 }, (_, index) => candidate(index + 1, 'easy')),
      ...Array.from({ length: 6 }, (_, index) => candidate(index + 20, 'medium')),
      ...Array.from({ length: 5 }, (_, index) => candidate(index + 40, 'hard')),
    ];

    const questions = buildRoadToGoalQuestionSet(candidates, () => 0.5);

    expect(questions).toHaveLength(11);
    expect(questions?.map((question) => question.difficulty)).toEqual(ROAD_TO_GOAL_DIFFICULTIES);
    expect(new Set(questions?.map((question) => question.question_id)).size).toBe(11);
    expect(questions?.every((question) => question.options.length === 4)).toBe(true);
    expect(JSON.stringify(questions?.[0].options)).not.toContain('is_correct');
  });

  it('keeps image media in the immutable snapshot without leaking metadata', () => {
    const candidates = [
      ...Array.from({ length: 4 }, (_, index) => candidate(index + 1, 'easy')),
      ...Array.from({ length: 4 }, (_, index) => candidate(index + 20, 'medium')),
      ...Array.from({ length: 3 }, (_, index) => candidate(index + 40, 'hard')),
    ];
    candidates[0] = {
      ...candidates[0],
      payload: {
        ...(candidates[0].payload as Record<string, unknown>),
        image: {
          url: 'https://cdn.example.com/player.jpg',
          width: 1200,
          height: 800,
          aspect_ratio: '3:2',
          author: 'not needed by the game client',
        },
      },
    };

    const questions = buildRoadToGoalQuestionSet(candidates, () => 0.99);
    const imageQuestion = questions?.find((question) => question.question_id === candidates[0].id);

    expect(imageQuestion?.image).toEqual({
      url: 'https://cdn.example.com/player.jpg',
      width: 1200,
      height: 800,
      aspect_ratio: '3:2',
    });
    expect(JSON.stringify(imageQuestion)).not.toContain('author');
  });

  it('preserves least-exposed priority while skipping malformed fallback rows', () => {
    const fallbackCandidates: RoadToGoalQuestionCandidate[] = [];
    for (const [offset, difficulty, count] of [
      [0, 'easy', 5],
      [20, 'medium', 5],
      [40, 'hard', 4],
    ] as const) {
      for (let priority = count; priority >= 1; priority -= 1) {
        fallbackCandidates.push({
          ...candidate(offset + priority, difficulty),
          selection_priority: priority,
        });
      }
    }
    fallbackCandidates.push({
      ...candidate(99, 'hard'),
      selection_priority: 0,
      payload: { options: [] },
    });

    const questions = buildRoadToGoalQuestionSet(
      fallbackCandidates,
      () => 0.5,
      'least_exposed'
    );

    expect(questions?.map((question) => question.question_id)).toEqual([
      ...[1, 2, 3, 4],
      ...[21, 22, 23, 24],
      ...[41, 42, 43],
    ].map((id) => candidate(id, id < 20 ? 'easy' : id < 40 ? 'medium' : 'hard').id));
  });

  it('skips malformed candidates and refuses an incomplete difficulty mix', () => {
    const candidates = [
      ...Array.from({ length: 4 }, (_, index) => candidate(index + 1, 'easy')),
      ...Array.from({ length: 4 }, (_, index) => candidate(index + 20, 'medium')),
      ...Array.from({ length: 2 }, (_, index) => candidate(index + 40, 'hard')),
      { ...candidate(99, 'hard'), payload: { options: [] } },
    ];

    expect(buildRoadToGoalQuestionSet(candidates, () => 0.5)).toBeNull();
  });
});
