import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';
import {
  explainClueGuess,
  fuzzyMatchesAnswer,
} from '../../src/realtime/possession-answer-matching.js';

const insertMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/modules/matches/clue-guess-evaluations.repo.js', () => ({
  clueGuessEvaluationsRepo: {
    insert: (...args: unknown[]) => insertMock(...args),
  },
}));

const { captureClueGuessEvaluation, shouldCaptureAccept } = await import(
  '../../src/realtime/clue-guess-capture.js'
);

const ACCEPTED = ['Roman Burki', 'Burki'];

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    matchId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    qIndex: 4,
    questionId: '33333333-3333-4333-8333-333333333333',
    guess: 'Roman Burki',
    acceptedAnswers: ACCEPTED,
    isCorrect: true,
    giveUp: false,
    timeMs: 4200,
    clueIndex: 2,
    isAi: false,
    ...overrides,
  };
}

beforeEach(() => {
  insertMock.mockReset();
  insertMock.mockResolvedValue(undefined);
});

describe('matcher behaviour is unchanged by instrumentation', () => {
  // Snapshot of the live verdicts. explainClueGuess must never disagree with
  // fuzzyMatchesAnswer, and fuzzyMatchesAnswer must keep these exact results.
  const cases: Array<{ guess: string; accepted: string[]; expected: boolean }> = [
    { guess: 'Roman Burki', accepted: ACCEPTED, expected: true },
    { guess: 'roman burki', accepted: ACCEPTED, expected: true },
    { guess: '  ROMAN   BÜRKI ', accepted: ACCEPTED, expected: true },
    { guess: 'Burki', accepted: ACCEPTED, expected: true },
    { guess: 'Romen Burki', accepted: ACCEPTED, expected: true },
    { guess: 'Roman', accepted: ACCEPTED, expected: true },
    { guess: 'Man Utd', accepted: ['Manchester United'], expected: true },
    { guess: 'Lionel Messi', accepted: ACCEPTED, expected: false },
    { guess: '', accepted: ACCEPTED, expected: false },
    { guess: 'xyz', accepted: ACCEPTED, expected: false },
    { guess: 'Roman Burki', accepted: [], expected: false },
  ];

  it.each(cases)('fuzzyMatchesAnswer("$guess") === $expected', ({ guess, accepted, expected }) => {
    expect(fuzzyMatchesAnswer(guess, accepted)).toBe(expected);
  });

  it.each(cases)('explainClueGuess agrees with the verdict for "$guess"', ({ guess, accepted, expected }) => {
    const explanation = explainClueGuess(guess, accepted);
    expect(explanation.matchedRule !== null).toBe(expected);
    expect(explanation.rejectReason === null).toBe(expected);
  });

  it('is pure: explaining a guess does not mutate the accepted answers', () => {
    const accepted = [...ACCEPTED];
    explainClueGuess('Roman Burki', accepted);
    expect(accepted).toEqual(ACCEPTED);
  });

  // The instrumentation is only trustworthy if its diagnosis can never contradict
  // the verdict players actually receive. Sweeping the awkward inputs this
  // matcher deals with (accents, Georgian script, apostrophes, short tokens,
  // empty sets) guards that invariant far better than the fixed cases above.
  it('never disagrees with the verdict across a broad input sweep', () => {
    const guesses = [
      '', ' ', '!!!', 'a', 'ab', 'abc', 'abcd', 'Pele', 'Pelé', 'pele',
      'Roman', 'Burki', 'Romen Burki', 'Roman Burkii', 'ROMAN BURKI', 'roman  burki',
      'Man Utd', 'man utd', 'Manchester United', 'Kaka', 'Kaká', 'Ronaldo',
      'Cristiano Ronaldo', 'C. Ronaldo', 'xyz', 'zzzzzzzzzz',
      'მიროსლავ კლოზე', 'კლოზე', "N'Golo Kante", 'Ngolo Kante', 'de Gea', 'De-Gea',
    ];
    const sets = [
      ['Roman Burki'], ['Roman Burki', 'Bürki'], ['Manchester United'], ['Pelé'],
      ['Kaká'], ['Cristiano Ronaldo'], ['Miroslav Klose', 'მიროსლავ კლოზე'],
      ["N'Golo Kanté"], ['David de Gea'], [''], [], ['a'], ['abcd'],
    ];

    const disagreements: string[] = [];
    for (const guess of guesses) {
      for (const accepted of sets) {
        const verdict = fuzzyMatchesAnswer(guess, accepted);
        const explanation = explainClueGuess(guess, accepted);
        if ((explanation.matchedRule !== null) !== verdict) {
          disagreements.push(`${JSON.stringify(guess)} vs ${JSON.stringify(accepted)}: verdict=${verdict} rule=${explanation.matchedRule}`);
        }
        // A reject must always carry a reason, and an accept must never carry one.
        if (!verdict && explanation.rejectReason === null) {
          disagreements.push(`missing rejectReason for ${JSON.stringify(guess)}`);
        }
        if (verdict && explanation.rejectReason !== null) {
          disagreements.push(`rejectReason on accept for ${JSON.stringify(guess)}`);
        }
        for (const candidate of explanation.candidates) {
          // A reported distance must always sit against a budget that could
          // have admitted it; "distance 1, allowed 0" is self-contradictory.
          if (candidate.bestDistance !== null && candidate.allowedDistance <= 0) {
            disagreements.push(`distance with zero budget: ${JSON.stringify(guess)} vs ${JSON.stringify(accepted)}`);
          }
          if (candidate.bestDistance === null && candidate.closestTypoTarget !== null) {
            disagreements.push(`target without distance: ${JSON.stringify(guess)}`);
          }
          // A typo accept must be within the budget recorded alongside it.
          if (candidate.matchedRule === 'typo' && (candidate.matchDistance ?? 0) > candidate.allowedDistance) {
            disagreements.push(`typo accept over budget: ${JSON.stringify(guess)} vs ${JSON.stringify(accepted)}`);
          }
        }
      }
    }

    expect(disagreements).toEqual([]);
  });
});

describe('explainClueGuess diagnosis', () => {
  it('reports the rule that accepted an exact match', () => {
    const explanation = explainClueGuess('Roman Burki', ACCEPTED);
    expect(explanation.matchedRule).toBe('exact');
    expect(explanation.matchDistance).toBe(0);
    expect(explanation.normalizedGuess).toBe('roman burki');
  });

  it('reports a typo accept with its edit distance', () => {
    const explanation = explainClueGuess('Romen Burki', ACCEPTED);
    expect(explanation.matchedRule).toBe('typo');
    expect(explanation.rejectReason).toBeNull();
  });

  it('explains a near-miss reject with per-candidate distances', () => {
    const explanation = explainClueGuess('Lionel Messi', ACCEPTED);
    expect(explanation.matchedRule).toBeNull();
    expect(explanation.rejectReason).toBe('no_rule_matched');
    expect(explanation.candidates).toHaveLength(2);
    for (const candidate of explanation.candidates) {
      expect(candidate.bestDistance).toBeGreaterThan(0);
      expect(candidate.normalizedAccepted).not.toBe('');
    }
  });

  it('flags a guess too short to reach the typo rule', () => {
    expect(explainClueGuess('xyz', ACCEPTED).rejectReason).toBe('below_typo_min_length');
  });

  it('flags an empty normalized guess (punctuation-only input)', () => {
    expect(explainClueGuess('!!!', ACCEPTED).rejectReason).toBe('empty_normalized_guess');
  });

  it('flags an empty answer set — the content-side failure mode', () => {
    expect(explainClueGuess('Roman Burki', ['']).rejectReason).toBe('empty_answer_set');
  });

  // Regression: short famous surnames (Pele, Kaka, Zico, Cafu) get a typo budget
  // of 0, so the typo rule never runs for them. Reporting those as a distance-1
  // near-miss against a budget of 0 would point the investigation at "loosen the
  // threshold" when the real story is that the rule never fired.
  describe('short-surname targets, the reported bug population', () => {
    it.each([
      ['Pelee', 'Pelé'],
      ['Kakaa', 'Kaká'],
      ['Ziko', 'Zico'],
      ['Cafuu', 'Cafu'],
    ])('classifies %s vs %s as no_typo_eligible_target', (guess, accepted) => {
      const explanation = explainClueGuess(guess, [accepted]);
      expect(explanation.matchedRule).toBeNull();
      expect(explanation.rejectReason).toBe('no_typo_eligible_target');
      // No misleading "close but over budget" pair.
      expect(explanation.candidates[0].closestTypoTarget).toBeNull();
      expect(explanation.candidates[0].bestDistance).toBeNull();
      expect(explanation.candidates[0].allowedDistance).toBe(0);
      // The true nearest distance is still available as context.
      expect(explanation.candidates[0].nearestDistance).toBe(1);
    });
  });

  it('never reports a distance against a budget that excluded it', () => {
    // 'abcd' is nearest but ineligible (budget 0); 'abcdefg' is the target the
    // matcher actually used. The recorded budget must belong to the recorded
    // target, and must never be a distance <= 0 budget pair.
    const explanation = explainClueGuess('abcde', ['abcd abcdefg']);
    const candidate = explanation.candidates[0];
    expect(candidate.closestTypoTarget).toBe('abcdefg');
    expect(candidate.allowedDistance).toBeGreaterThan(0);
    expect(candidate.bestDistance).toBe(2);
    // match_distance comes from the matcher, not re-derived from the nearest target.
    expect(explanation.matchDistance).toBe(2);
    expect(candidate.nearestDistance).toBe(1);
  });

  it('records the matcher-produced distance for every typo accept', () => {
    // Guards the class of bug where match_distance was re-derived as the min
    // over ALL targets and could undercount the real match distance.
    const inputs: Array<[string, string[]]> = [
      ['Romen Burki', ['Roman Burki']],
      ['abcde', ['abcd abcdefg']],
      ['Cristiano Ronald', ['Cristiano Ronaldo']],
    ];
    for (const [guess, accepted] of inputs) {
      const explanation = explainClueGuess(guess, accepted);
      if (explanation.matchedRule !== 'typo') continue;
      const matched = explanation.candidates.find((c) => c.matchedRule === 'typo');
      expect(explanation.matchDistance).toBe(matched?.matchDistance);
      expect(explanation.matchDistance).toBeLessThanOrEqual(matched!.allowedDistance);
    }
  });

  it('reports a content problem as such, not as a too-short guess', () => {
    // Ordering guard: an unusable answer set must not be labelled
    // below_typo_min_length just because the guess was short.
    expect(explainClueGuess('Pel', ['']).rejectReason).toBe('empty_answer_set');
  });
});

describe('captureClueGuessEvaluation', () => {
  it('always writes a row for a reject, with the full forensic field set', async () => {
    const written = await captureClueGuessEvaluation(
      baseInput({ guess: 'Lionel Messi', isCorrect: false, random: 0.99 })
    );

    expect(written).toBe(true);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertMock.mock.calls[0][0];
    expect(row).toMatchObject({
      matchId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      qIndex: 4,
      questionId: '33333333-3333-4333-8333-333333333333',
      rawGuess: 'Lionel Messi',
      normalizedGuess: 'lionel messi',
      isCorrect: false,
      giveUp: false,
      matchRule: null,
      rejectReason: 'no_rule_matched',
      timeMs: 4200,
      clueIndex: 2,
      isAi: false,
      captureMode: 'full',
    });
    expect(row.acceptedAnswers).toEqual(ACCEPTED);
    expect(row.normalizedAcceptedAnswers).toEqual(['roman burki', 'burki']);
    expect(row.candidateDetail).toHaveLength(2);
  });

  it('preserves the raw guess verbatim, including case and spacing', async () => {
    await captureClueGuessEvaluation(
      baseInput({ guess: '  ROMAN   BÜRKI ', isCorrect: false })
    );
    expect(insertMock.mock.calls[0][0].rawGuess).toBe('  ROMAN   BÜRKI ');
  });

  it('writes an accept when the sampler selects it, marked as sampled', async () => {
    const written = await captureClueGuessEvaluation(baseInput({ isCorrect: true, random: 0.01 }));

    expect(written).toBe(true);
    expect(insertMock.mock.calls[0][0]).toMatchObject({
      isCorrect: true,
      matchRule: 'exact',
      rejectReason: null,
      captureMode: 'sampled',
    });
  });

  it('skips an accept the sampler passes over', async () => {
    const written = await captureClueGuessEvaluation(baseInput({ isCorrect: true, random: 0.9 }));
    expect(written).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('never skips a reject regardless of the sampler roll', async () => {
    for (const random of [0, 0.5, 0.999]) {
      insertMock.mockClear();
      await captureClueGuessEvaluation(baseInput({ isCorrect: false, random }));
      expect(insertMock).toHaveBeenCalledTimes(1);
    }
  });

  it('records is_ai so harness/bot junk guesses can be filtered out', async () => {
    await captureClueGuessEvaluation(baseInput({ isCorrect: false, isAi: true }));
    expect(insertMock.mock.calls[0][0].isAi).toBe(true);
  });

  it('does not log give-ups (no guess text to diagnose)', async () => {
    const written = await captureClueGuessEvaluation(
      baseInput({ guess: '', giveUp: true, isCorrect: false })
    );
    expect(written).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('samples accepts at roughly 10%', () => {
    expect(shouldCaptureAccept(0)).toBe(true);
    expect(shouldCaptureAccept(0.099)).toBe(true);
    expect(shouldCaptureAccept(0.1)).toBe(false);
    expect(shouldCaptureAccept(0.5)).toBe(false);
  });
});
