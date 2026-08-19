import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const getPublishedGoalMock = vi.fn();
const pickNextGoalMock = vi.fn();
const hasSeenGoalMock = vi.fn();
const getSessionByNonceMock = vi.fn();
const getOpenSessionMock = vi.fn();
const getOpenSessionForUpdateMock = vi.fn();
const getFinishedSessionMock = vi.fn();
const abandonSessionMock = vi.fn();
const insertSessionMock = vi.fn();
const updateSessionMock = vi.fn();
const insertSolveMock = vi.fn();
const coinsGrantedTodayMock = vi.fn();
const countSolvedMock = vi.fn();
const countPublishedMock = vi.fn();

vi.mock('../../src/modules/guess-the-goal/guess-the-goal.repo.js', () => ({
  guessTheGoalRepo: {
    getPublishedGoal: (...a: unknown[]) => getPublishedGoalMock(...a),
    pickNextGoal: (...a: unknown[]) => pickNextGoalMock(...a),
    hasSeenGoal: (...a: unknown[]) => hasSeenGoalMock(...a),
    hasSolvedGoal: vi.fn(),
    getSessionByNonce: (...a: unknown[]) => getSessionByNonceMock(...a),
    getOpenSession: (...a: unknown[]) => getOpenSessionMock(...a),
    getOpenSessionForUpdate: (...a: unknown[]) => getOpenSessionForUpdateMock(...a),
    getFinishedSession: (...a: unknown[]) => getFinishedSessionMock(...a),
    abandonSession: (...a: unknown[]) => abandonSessionMock(...a),
    insertSession: (...a: unknown[]) => insertSessionMock(...a),
    updateSession: (...a: unknown[]) => updateSessionMock(...a),
    insertSolve: (...a: unknown[]) => insertSolveMock(...a),
    coinsGrantedToday: (...a: unknown[]) => coinsGrantedTodayMock(...a),
    countSolved: (...a: unknown[]) => countSolvedMock(...a),
    countPublished: (...a: unknown[]) => countPublishedMock(...a),
    runInTransaction: (cb: (tx: unknown) => unknown) => cb({}),
  },
}));

const addCoinsInTxMock = vi.fn();
const insertTransactionLogInTxMock = vi.fn();
vi.mock('../../src/modules/store/store.repo.js', () => ({
  storeRepo: {
    addCoinsInTx: (...a: unknown[]) => addCoinsInTxMock(...a),
    insertTransactionLogInTx: (...a: unknown[]) => insertTransactionLogInTxMock(...a),
  },
}));

const grantXpInTxMock = vi.fn();
vi.mock('../../src/modules/progression/progression.repo.js', () => ({
  progressionRepo: {
    grantXpInTx: (...a: unknown[]) => grantXpInTxMock(...a),
  },
}));

vi.mock('../../src/db/index.js', () => ({
  sql: Object.assign(() => Promise.resolve([]), {
    begin: (cb: (tx: unknown) => unknown) => Promise.resolve(cb({})),
    json: (x: unknown) => x,
  }),
}));

import { guessTheGoalService } from '../../src/modules/guess-the-goal/guess-the-goal.service.js';

const USER = 'user-1';

function makeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'goal-1',
    slug: 'maradona-england-1986',
    status: 'published',
    difficulty: 'easy',
    title: { en: 'Diego Maradona — Argentina vs England, 1986' },
    options: [
      { id: 'a', text: { en: 'Maradona 1986' }, is_correct: true },
      { id: 'b', text: { en: 'Messi 2007' }, is_correct: false },
      { id: 'c', text: { en: 'Weah 1996' }, is_correct: false },
      { id: 'd', text: { en: 'Giggs 1999' }, is_correct: false },
    ],
    fun_fact: { en: 'Goal of the century.' },
    bonus: {
      question: { en: 'Minutes before, the match saw…' },
      options: [
        { id: 'a', text: { en: 'Hand of God' }, is_correct: true },
        { id: 'b', text: { en: 'A penalty' }, is_correct: false },
        { id: 'c', text: { en: 'A red card' }, is_correct: false },
        { id: 'd', text: { en: 'An own goal' }, is_correct: false },
      ],
    },
    players: [
      { id: 'maradona', team: 'attack', at: [44, 38] },
      { id: 'shilton', team: 'keeper', at: [34, 101] },
    ],
    steps: [
      { kind: 'carry', player: 'maradona', to: [44, 78], duration: 2.0 },
      { kind: 'carry', player: 'maradona', to: [35, 92], duration: 2.0 },
      { kind: 'carry', player: 'maradona', to: [30, 99], duration: 2.0 },
      { kind: 'shot', player: 'maradona', to: [33, 105], duration: 1.0 },
    ],
    scorer: 'Diego Maradona',
    match_label: 'Argentina vs England',
    year: 1986,
    goal_ordinal: 1,
    schema_version: 1,
    source: 'seed',
    created_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function snapshotOf(goal = makeGoal()) {
  return {
    difficulty: goal.difficulty,
    title: goal.title,
    fun_fact: goal.fun_fact,
    players: goal.players.map((p: { id: string }, i: number) => ({ ...p, id: `p${i + 1}` })),
    steps: goal.steps.map((s: { player: string }, i: number) => ({
      ...s,
      player: goal.players.findIndex((p: { id: string }) => p.id === s.player) >= 0
        ? `p${goal.players.findIndex((p: { id: string }) => p.id === s.player) + 1}`
        : s.player,
    })),
    options: goal.options,
    bonus: goal.bonus,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    user_id: USER,
    goal_id: 'goal-1',
    goal_snapshot: snapshotOf(),
    state: 'active',
    max_points: 100,
    started_at: new Date(),
    guessed_at: null,
    guess_option_id: null,
    guess_correct: null,
    revealed_moves: null,
    points: 0,
    bonus_option_id: null,
    bonus_correct: null,
    bonus_points: 0,
    first_solve: false,
    coins_awarded: 0,
    xp_awarded: 0,
    client_nonce: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  countSolvedMock.mockResolvedValue(3);
  countPublishedMock.mockResolvedValue(31);
  coinsGrantedTodayMock.mockResolvedValue(0);
  hasSeenGoalMock.mockResolvedValue(false);
  addCoinsInTxMock.mockResolvedValue({ coins: 500 });
  insertTransactionLogInTxMock.mockResolvedValue({});
  grantXpInTxMock.mockResolvedValue({ awarded: true, totalXp: 1000 });
  updateSessionMock.mockImplementation((_tx: unknown, _id: string, patch: Record<string, unknown>) =>
    Promise.resolve(makeSession(patch))
  );
});

describe('startSession', () => {
  it('serves anonymized players and never leaks answers or the title', async () => {
    getOpenSessionForUpdateMock.mockResolvedValue(null);
    pickNextGoalMock.mockResolvedValue(makeGoal());
    insertSessionMock.mockImplementation((_tx: unknown, data: { goalSnapshot: unknown }) =>
      Promise.resolve(makeSession({ goal_snapshot: data.goalSnapshot }))
    );

    const state = await guessTheGoalService.startSession(USER, null);

    const payload = JSON.stringify(state);
    expect(payload).not.toContain('maradona');
    expect(payload).not.toContain('Maradona —');
    expect(payload).not.toContain('is_correct');
    expect(payload).not.toContain('fun_fact');
    expect(payload).not.toContain('Hand of God');
    expect(state.goal.players.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(state.goal.steps.every((s) => s.player.startsWith('p'))).toBe(true);
    expect(state.goal.options).toHaveLength(4);
    expect(state.max_points).toBe(100);
    expect(state.goal.main_moves).toBe(4);
  });

  it('clamps max points to the floor for a previously seen goal', async () => {
    getOpenSessionForUpdateMock.mockResolvedValue(null);
    pickNextGoalMock.mockResolvedValue(makeGoal());
    hasSeenGoalMock.mockResolvedValue(true);
    insertSessionMock.mockImplementation((_tx: unknown, data: { maxPoints: number }) =>
      Promise.resolve(makeSession({ max_points: data.maxPoints }))
    );

    const state = await guessTheGoalService.startSession(USER, null);
    expect(state.max_points).toBe(40);
  });

  it('nonce retry returns the already-created session without inserting', async () => {
    getSessionByNonceMock.mockResolvedValue(makeSession({ client_nonce: 'n1' }));

    const state = await guessTheGoalService.startSession(USER, 'n1');
    expect(state.session_id).toBe('session-1');
    expect(insertSessionMock).not.toHaveBeenCalled();
    expect(abandonSessionMock).not.toHaveBeenCalled();
  });

  it('abandons a previous open session before starting a new one', async () => {
    getSessionByNonceMock.mockResolvedValue(null);
    getOpenSessionForUpdateMock.mockResolvedValue(makeSession({ id: 'old' }));
    pickNextGoalMock.mockResolvedValue(makeGoal());
    insertSessionMock.mockResolvedValue(makeSession());

    await guessTheGoalService.startSession(USER, 'n2');
    expect(abandonSessionMock).toHaveBeenCalledWith({}, 'old');
  });
});

describe('guess', () => {
  it('instant correct guess scores max and pays first-solve rewards', async () => {
    getOpenSessionForUpdateMock.mockResolvedValue(makeSession());
    insertSolveMock.mockResolvedValue(true);

    const outcome = await guessTheGoalService.guess(USER, 'session-1', 'a');

    expect(outcome.correct).toBe(true);
    expect(outcome.points).toBe(100);
    expect(outcome.session_state).toBe('guessed');
    expect(outcome.awards.first_solve).toBe(true);
    expect(outcome.awards.coins).toBe(25);
    expect(outcome.awards.xp).toBe(50);
    expect(outcome.awards.wallet_coins).toBe(500);
    expect(outcome.awards.total_xp).toBe(1000);
    expect(outcome.bonus?.options.every((o) => !('is_correct' in o))).toBe(true);
    expect(addCoinsInTxMock).toHaveBeenCalledWith({}, USER, 25);
  });

  it('late guess scores the floor', async () => {
    const startedAt = new Date(Date.now() - 60_000);
    getOpenSessionForUpdateMock.mockResolvedValue(makeSession({ started_at: startedAt }));
    insertSolveMock.mockResolvedValue(true);

    const outcome = await guessTheGoalService.guess(USER, 'session-1', 'a');
    expect(outcome.points).toBe(40);
  });

  it('wrong guess pays nothing and completes the session', async () => {
    getOpenSessionForUpdateMock.mockResolvedValue(makeSession());

    const outcome = await guessTheGoalService.guess(USER, 'session-1', 'b');
    expect(outcome.correct).toBe(false);
    expect(outcome.points).toBe(0);
    expect(outcome.session_state).toBe('complete');
    expect(outcome.correct_option_id).toBe('a');
    expect(insertSolveMock).not.toHaveBeenCalled();
    expect(addCoinsInTxMock).not.toHaveBeenCalled();
  });

  it('a repeat solve (already in solves table) grants nothing', async () => {
    getOpenSessionForUpdateMock.mockResolvedValue(makeSession());
    insertSolveMock.mockResolvedValue(false);

    const outcome = await guessTheGoalService.guess(USER, 'session-1', 'a');
    expect(outcome.correct).toBe(true);
    expect(outcome.awards.first_solve).toBe(false);
    expect(outcome.awards.coins).toBe(0);
    expect(addCoinsInTxMock).not.toHaveBeenCalled();
    expect(grantXpInTxMock).not.toHaveBeenCalled();
  });

  it('the daily cap trims the coin grant but XP still flows', async () => {
    getOpenSessionForUpdateMock.mockResolvedValue(makeSession());
    insertSolveMock.mockResolvedValue(true);
    coinsGrantedTodayMock.mockResolvedValue(290);

    const outcome = await guessTheGoalService.guess(USER, 'session-1', 'a');
    expect(outcome.awards.coins).toBe(10);
    expect(outcome.awards.daily_cap_reached).toBe(true);
    expect(outcome.awards.xp).toBe(50);
    expect(addCoinsInTxMock).toHaveBeenCalledWith({}, USER, 10);
  });

  it('retrying the same option replays the stored outcome without paying twice', async () => {
    getOpenSessionForUpdateMock.mockResolvedValue(
      makeSession({
        state: 'guessed',
        guess_option_id: 'a',
        guess_correct: true,
        points: 80,
        revealed_moves: 2,
        first_solve: true,
        coins_awarded: 20,
        xp_awarded: 40,
      })
    );

    const outcome = await guessTheGoalService.guess(USER, 'session-1', 'a');
    expect(outcome.points).toBe(80);
    expect(outcome.session_state).toBe('guessed');
    expect(addCoinsInTxMock).not.toHaveBeenCalled();
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('retrying with a DIFFERENT option conflicts', async () => {
    getOpenSessionForUpdateMock.mockResolvedValue(
      makeSession({ state: 'guessed', guess_option_id: 'a', guess_correct: true })
    );
    await expect(guessTheGoalService.guess(USER, 'session-1', 'b')).rejects.toThrow(
      /different option/
    );
  });

  it('replays a completed session found outside the open-session lock', async () => {
    getOpenSessionForUpdateMock.mockResolvedValue(null);
    getFinishedSessionMock.mockResolvedValue(
      makeSession({ state: 'complete', guess_option_id: 'b', guess_correct: false, points: 0 })
    );
    const outcome = await guessTheGoalService.guess(USER, 'session-1', 'b');
    expect(outcome.correct).toBe(false);
    expect(outcome.session_state).toBe('complete');
  });
});

describe('answerBonus', () => {
  it('grants bonus rewards only on first-solve sessions', async () => {
    getOpenSessionForUpdateMock.mockResolvedValue(
      makeSession({ state: 'guessed', guess_correct: true, first_solve: true, coins_awarded: 25, xp_awarded: 50 })
    );

    const outcome = await guessTheGoalService.answerBonus(USER, 'session-1', 'a');
    expect(outcome.correct).toBe(true);
    expect(outcome.bonus_points).toBe(40);
    expect(outcome.awards.coins).toBe(10);
    expect(outcome.awards.xp).toBe(20);
    expect(grantXpInTxMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ sourceKey: 'goal-1:bonus' })
    );
  });

  it('bonus on a non-first-solve session pays nothing', async () => {
    getOpenSessionForUpdateMock.mockResolvedValue(
      makeSession({ state: 'guessed', guess_correct: true, first_solve: false })
    );

    const outcome = await guessTheGoalService.answerBonus(USER, 'session-1', 'a');
    expect(outcome.correct).toBe(true);
    expect(outcome.awards.coins).toBe(0);
    expect(addCoinsInTxMock).not.toHaveBeenCalled();
  });

  it('wrong bonus answer completes with zero bonus points', async () => {
    getOpenSessionForUpdateMock.mockResolvedValue(
      makeSession({ state: 'guessed', guess_correct: true, first_solve: true })
    );
    const outcome = await guessTheGoalService.answerBonus(USER, 'session-1', 'c');
    expect(outcome.correct).toBe(false);
    expect(outcome.bonus_points).toBe(0);
    expect(outcome.correct_option_id).toBe('a');
    expect(addCoinsInTxMock).not.toHaveBeenCalled();
  });
});
