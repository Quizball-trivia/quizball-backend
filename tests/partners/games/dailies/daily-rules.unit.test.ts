import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/db/index.js', () => ({ sql: {} }));

const {
  careerPathRules,
  countdownRules,
  higherLowerRules,
  pickEmRules,
  trueFalseRules,
  COUNTDOWN_MAX_ANSWERS_PER_PLAY,
  COUNTDOWN_MAX_GUESSES_PER_ROUND,
  PARTNER_DAILY_RULES,
} = await import('../../../../src/modules/partners/games/dailies/daily-rules.js');
const { PARTNER_GAME_MAX_SCORE } = await import('../../../../src/modules/partners/partner-games.js');

// Generated fixtures only (the repository is public): no real question or answer.
const category = { en: 'Fixture category', ka: 'ფიქსტურა' };
const row = (payload: unknown, prompt: unknown = { en: 'Fixture prompt?', ka: 'ფიქსტურა?' }) => ({
  id: '00000000-0000-4000-8000-000000000001',
  prompt: prompt as never,
  payload: payload as never,
  category_name: category as never,
});
const ctx = { foundInPlay: 0, locale: 'en' };

/** Every value that would give an answer away, searched for in what the browser receives. */
function expectNoLeak(view: unknown, secrets: Array<string | number | boolean>, keys: string[]) {
  const json = JSON.stringify(view);
  for (const key of keys) expect(json).not.toContain(`"${key}"`);
  for (const secret of secrets) expect(json).not.toContain(String(secret));
}

describe('frozen counts, timings and maximum scores (contract §7)', () => {
  it.each([
    ['true-false', 4, 15, 50 * 4],
    ['pick-em', 2, 30, 250 * 2],
    ['career-path', 3, 30, 100 * 3],
    ['higher-lower', 2, 30, 200 * 2],
    ['countdown', 2, 30, 50 * 50],
  ] as const)('%s: %i items × %i s, max %i = the partner cap', (gameId, count, seconds, max) => {
    const rules = PARTNER_DAILY_RULES[gameId];
    expect(rules.itemCount).toBe(count);
    expect(rules.secondsPerItem).toBe(seconds);
    expect(PARTNER_GAME_MAX_SCORE[gameId]).toBe(max);
  });
});

describe('true / false', () => {
  const item = trueFalseRules.snapshot(row({
    type: 'true_false',
    options: [
      { id: 'true', text: { en: 'Yes-label' }, is_correct: false },
      { id: 'false', text: { en: 'No-label' }, is_correct: true },
    ],
  }))!;

  it('shows the statement and labels, never which is right', () => {
    const view = trueFalseRules.view(item, trueFalseRules.initialState(item), 'en');
    expect(view).toEqual({ category: 'Fixture category', prompt: 'Fixture prompt?', trueLabel: 'Yes-label', falseLabel: 'No-label' });
    expectNoLeak(view, [], ['answer', 'correct', 'is_correct', 'correctAnswer']);
  });

  it('100 for a correct answer, 0 for a wrong one or none', () => {
    const right = trueFalseRules.answer(item, trueFalseRules.initialState(item), { answer: false }, ctx);
    expect(right.feedback).toEqual({ correct: true });
    expect(trueFalseRules.points(item, right.state)).toBe(50);
    expect(trueFalseRules.reveal(item, right.state, 'en')).toEqual({ correctAnswer: false, picked: false, correct: true });
    const wrong = trueFalseRules.answer(item, trueFalseRules.initialState(item), { answer: true }, ctx);
    expect(trueFalseRules.points(item, wrong.state)).toBe(0);
    const none = trueFalseRules.close(item, trueFalseRules.initialState(item), 'timeout');
    expect(none).toMatchObject({ resolved: true, cause: 'timeout' });
    expect(trueFalseRules.points(item, none)).toBe(0);
  });

  it('localizes with an English fallback', () => {
    const view = trueFalseRules.view(item, trueFalseRules.initialState(item), 'ka') as { prompt: string; trueLabel: string };
    expect(view.prompt).toBe('ფიქსტურა?');
    expect(view.trueLabel).toBe('Yes-label');
  });
});

describe('pick em', () => {
  const item = pickEmRules.snapshot(row({
    type: 'imposter_multi_select',
    options: ['o1', 'o2', 'o3', 'o4', 'o5'].map((id, i) => ({ id, text: { en: `Option ${i}` }, is_correct: i < 2 })),
  }))!;

  it('lists options without marking the right ones', () => {
    const view = pickEmRules.view(item, pickEmRules.initialState(item), 'en');
    expectNoLeak(view, [], ['correct', 'is_correct', 'correctOptionIds']);
  });

  it('250 only for exactly the right set (order and repeats do not matter)', () => {
    const init = pickEmRules.initialState(item);
    expect(pickEmRules.points(item, pickEmRules.answer(item, init, { optionIds: ['o2', 'o1', 'o1'] }, ctx).state)).toBe(250);
    expect(pickEmRules.points(item, pickEmRules.answer(item, init, { optionIds: ['o1'] }, ctx).state)).toBe(0);
    expect(pickEmRules.points(item, pickEmRules.answer(item, init, { optionIds: ['o1', 'o2', 'o3'] }, ctx).state)).toBe(0);
    // An id that is not an option makes the submission wrong, even next to the right set.
    expect(pickEmRules.points(item, pickEmRules.answer(item, init, { optionIds: ['o1', 'o2', 'nope'] }, ctx).state)).toBe(0);
    expect(pickEmRules.points(item, pickEmRules.answer(item, init, { optionIds: null }, ctx).state)).toBe(0);
  });

  it('shuffles the options, so the authored order (right answers first) does not show where they are', () => {
    const firstIds = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      const drawn = pickEmRules.snapshot(row({
        type: 'imposter_multi_select',
        options: ['o1', 'o2', 'o3', 'o4', 'o5'].map((id, j) => ({ id, text: { en: `Option ${j}` }, is_correct: j < 2 })),
      }))!;
      expect(drawn.options.map((o) => o.id).sort()).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);
      firstIds.add(drawn.options[0]!.id);
    }
    expect(firstIds.size).toBeGreaterThan(2);
  });
});

describe('career path', () => {
  const item = careerPathRules.snapshot(row({
    type: 'career_path',
    clubs: [{ en: 'Club A' }, { en: 'Club B' }, { en: 'Club C' }],
    display_answer: { en: 'Fixturo Testerson', ka: 'ფიქსტურო ტესტერსონი' },
    accepted_answers: ['Fixturo Testerson', 'Testerson'],
  }))!;

  it('shows the clubs only', () => {
    const view = careerPathRules.view(item, careerPathRules.initialState(item), 'en');
    expect(view).toMatchObject({ clubs: ['Club A', 'Club B', 'Club C'] });
    expectNoLeak(view, ['Testerson', 'ფიქსტურო'], ['displayAnswer', 'accepted']);
  });

  it('server fuzzy matching: surname, small typo and the localized name count; one guess only', () => {
    const init = careerPathRules.initialState(item);
    for (const guess of ['Testerson', 'testersn', 'fixturo testerson', 'ფიქსტურო ტესტერსონი']) {
      expect(careerPathRules.answer(item, init, { guess }, ctx).feedback).toEqual({ correct: true });
    }
    const wrong = careerPathRules.answer(item, init, { guess: 'Somebody Else' }, ctx);
    expect(wrong.state).toMatchObject({ resolved: true, correct: false });
    expect(careerPathRules.points(item, wrong.state)).toBe(0);
    expect(careerPathRules.reveal(item, wrong.state, 'en')).toEqual({ displayAnswer: 'Fixturo Testerson', correct: false });
  });

  it('two items with the same answer share an answer key (never both in one play)', () => {
    expect(careerPathRules.answerKeys(item)).toContain('fixturo testerson');
  });
});

describe('higher / lower', () => {
  const item = higherLowerRules.snapshot(row({
    type: 'high_low',
    stat_label: { en: 'Fixture stat' },
    matchups: [
      { id: 'm0', left_name: { en: 'Alpha' }, left_value: 7, right_name: { en: 'Bravo' }, right_value: 3 },
      { id: 'm1', left_name: { en: 'Charlie' }, left_value: 2, right_name: { en: 'Delta' }, right_value: 9 },
    ],
  }))!;
  const higherSide = (i: number) => (item.matchups[i].left.value >= item.matchups[i].right.value ? 'left' : 'right');
  const lowerSide = (i: number) => (higherSide(i) === 'left' ? 'right' : 'left');

  it('shows names, never values', () => {
    const view = higherLowerRules.view(item, higherLowerRules.initialState(item), 'en');
    expectNoLeak(view, [7, 3, 9], ['value', 'leftValue', 'rightValue']);
  });

  it('200 for a round cleared without a mistake; a mistake or the clock ends it with 0', () => {
    let state = higherLowerRules.initialState(item);
    const first = higherLowerRules.answer(item, state, { matchupIndex: 0, pick: higherSide(0) }, ctx);
    expect(first.state).toMatchObject({ resolved: false, matchupIndex: 1 });
    // A repeated pick for the matchup already passed changes nothing.
    expect(higherLowerRules.answer(item, first.state, { matchupIndex: 0, pick: lowerSide(0) }, ctx).state).toBe(first.state);
    state = higherLowerRules.answer(item, first.state, { matchupIndex: 1, pick: higherSide(1) }, ctx).state;
    expect(state).toMatchObject({ resolved: true, cleared: true });
    expect(higherLowerRules.points(item, state)).toBe(200);

    const miss = higherLowerRules.answer(item, higherLowerRules.initialState(item), { matchupIndex: 0, pick: lowerSide(0) }, ctx);
    expect(miss.state).toMatchObject({ resolved: true, cleared: false });
    expect(higherLowerRules.points(item, miss.state)).toBe(0);
    expect(higherLowerRules.points(item, higherLowerRules.close(item, first.state, 'timeout'))).toBe(0);
  });
});

describe('countdown', () => {
  const groups = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((name, i) => ({
    id: `g${i}`,
    display: { en: `${name} Fixture` },
    accepted_answers: [`${name} Fixture`, name],
  }));
  const item = countdownRules.snapshot(row({ type: 'countdown_list', prompt: { en: 'Name the fixtures' }, answer_groups: groups }))!;

  it('shows the prompt and only what the player found', () => {
    const view = countdownRules.view(item, countdownRules.initialState(item), 'en');
    expect(view).toEqual({ category: 'Fixture category', prompt: 'Name the fixtures', found: [] });
    expectNoLeak(view, ['Alpha', 'Bravo'], ['accepted', 'groups']);
  });

  it('50 per distinct answer group; a second spelling of the same answer counts once', () => {
    let state = countdownRules.initialState(item);
    for (const guess of ['Alpha', 'alpha fixture', 'Alpah', 'Bravo Fixture', 'nothing']) {
      state = countdownRules.answer(item, state, { guess }, { ...ctx, foundInPlay: state.found.length }).state;
    }
    expect(state.found).toEqual(['g0', 'g1']);
    expect(countdownRules.points(item, state)).toBe(100);
    expect(countdownRules.reveal(item, state, 'en')).toEqual({ found: ['Alpha Fixture', 'Bravo Fixture'] });
  });

  it('a partial or misspelt name counts only from 5 letters; guesses per round are capped', () => {
    const play = (guesses: string[]) => {
      let state = countdownRules.initialState(item);
      for (const guess of guesses) state = countdownRules.answer(item, state, { guess }, { ...ctx, foundInPlay: state.found.length }).state;
      return state;
    };
    expect(play(['Cha', 'Char', 'Del', 'Delt', 'Alph']).found).toEqual([]);
    expect(play(['Charl']).found).toEqual(['g2']);
    const capped = play([...Array.from({ length: COUNTDOWN_MAX_GUESSES_PER_ROUND }, () => 'nothing'), 'Alpha']);
    expect(capped.found).toEqual([]);
    expect(capped.guesses).toBe(COUNTDOWN_MAX_GUESSES_PER_ROUND);
  });

  it('repeating a found answer never claims another group through a weaker match', () => {
    const close = countdownRules.snapshot(row({
      type: 'countdown_list',
      prompt: { en: 'Name the fixtures' },
      answer_groups: [
        { id: 'a', display: { en: 'Fixturo Testerson' }, accepted_answers: ['Fixturo Testerson', 'Testerson'] },
        { id: 'b', display: { en: 'Fixturo Testersun' }, accepted_answers: ['Fixturo Testersun', 'Testersun'] },
      ],
    }))!;
    let state = countdownRules.initialState(close);
    for (let i = 0; i < 3; i += 1) {
      state = countdownRules.answer(close, state, { guess: 'Fixturo Testerson' }, { ...ctx, foundInPlay: state.found.length }).state;
    }
    expect(state.found).toEqual(['a']);
    expect(countdownRules.points(close, state)).toBe(50);
    // The other answer is still found by its own name.
    state = countdownRules.answer(close, state, { guess: 'Testersun' }, ctx).state;
    expect(state.found).toEqual(['a', 'b']);
  });

  it(`stops counting at ${COUNTDOWN_MAX_ANSWERS_PER_PLAY} answers in a play`, () => {
    const capped = countdownRules.answer(item, countdownRules.initialState(item), { guess: 'Alpha' }, { ...ctx, foundInPlay: COUNTDOWN_MAX_ANSWERS_PER_PLAY });
    expect(capped.feedback).toMatchObject({ accepted: false, capped: true });
    expect(capped.state.found).toEqual([]);
  });
});

describe('snapshot refuses content the game cannot play', () => {
  it('wrong type, missing prompt or duplicate option ids', () => {
    expect(trueFalseRules.snapshot(row({ type: 'countdown_list', prompt: { en: 'x' }, answer_groups: [] }))).toBeNull();
    expect(pickEmRules.snapshot(row({
      type: 'imposter_multi_select',
      options: ['a', 'a', 'b', 'c'].map((id, i) => ({ id, text: { en: `o${i}` }, is_correct: i === 0 })),
    }))).toBeNull();
    expect(trueFalseRules.snapshot(row({
      type: 'true_false',
      options: [{ id: 'true', text: { en: 'T' }, is_correct: true }, { id: 'false', text: { en: 'F' }, is_correct: false }],
    }, null))).toBeNull();
  });
});
