import { describe, expect, it } from 'vitest';
import '../setup.js';

import {
  advanceToNextRoundOrFinish,
  applyBid,
  applyFold,
  applyTurnTimeout,
  assignFootballerToSquad,
  createInitialAuctionMatch,
  finishMatch,
  pickNextPosition,
  revealNextClue,
  selectSoloPickOption,
  startBidding,
  startBiddingRound,
  type AuctionCardPool,
  type AuctionEngineContext,
} from '../../src/modules/auction/auction-engine.js';
import { createEmptyTeam } from '../../src/modules/auction/auction-rules.js';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { AuctionFootballer, AuctionPlayer, PositionGroup } from '../../src/modules/auction/auction.types.js';

function context(random = 0.999): AuctionEngineContext {
  let id = 0;
  return {
    now: () => new Date('2026-06-20T10:00:00.000Z'),
    random: () => random,
    createId: (kind) => `${kind}-${++id}`,
  };
}

function card(
  id: string,
  positionGroup: PositionGroup = 'FWD',
  trueValue = 100_000_000,
  startingPrice = 10_000_000
): AuctionFootballer {
  return {
    id,
    clueCardId: `${id}-clue`,
    name: `Player ${id}`,
    positionGroup,
    trueValue,
    startingPrice,
    clues: [`${id} clue 1`, `${id} clue 2`, `${id} clue 3`],
    imageUrl: `https://img.example/${id}.jpg`,
    currentClub: 'QuizBall FC',
    nationality: 'Georgia',
  };
}

function createMatch(ctx = context()): AuctionMatchState {
  return createInitialAuctionMatch({
    matchId: 'match-1',
    humanUserId: 'user-1',
    humanDisplayName: 'Human',
    formation: '4-3-3',
    context: ctx,
  });
}

function revealAllAndStart(state: AuctionMatchState, ctx = context()): AuctionMatchState {
  let next = state;
  next = revealNextClue(next, ctx);
  next = revealNextClue(next, ctx);
  next = revealNextClue(next, ctx);
  return startBidding(next, ctx);
}

function startReadyBiddingRound(
  footballer = card('haaland', 'FWD', 180_000_000, 30_000_000),
  ctx = context()
): AuctionMatchState {
  const initial = createMatch(ctx);
  const round = startBiddingRound(initial, 'FWD', footballer, initial.seats, ctx);
  return revealAllAndStart(round, ctx);
}

function withBudget(state: AuctionMatchState, seatId: string, budget: number): AuctionMatchState {
  return {
    ...state,
    seats: state.seats.map((seat) => seat.seatId === seatId ? { ...seat, budget } : seat),
  };
}

function completeTeamPlayer(seatId: string, totalValue: number, isBot = false): AuctionPlayer {
  const team = createEmptyTeam('4-3-3');
  const values = Array.from({ length: 11 }, (_, index) => (
    index === 0 ? totalValue - 10 : 1
  ));
  const filled = {
    GK: [card(`${seatId}-gk`, 'GK', values[0])],
    DEF: [1, 2, 3, 4].map((index) => card(`${seatId}-def-${index}`, 'DEF', values[index])),
    MID: [5, 6, 7].map((index) => card(`${seatId}-mid-${index}`, 'MID', values[index])),
    FWD: [8, 9, 10].map((index) => card(`${seatId}-fwd-${index}`, 'FWD', values[index])),
  };
  return {
    seatId,
    userId: isBot ? null : `${seatId}-user`,
    displayName: seatId,
    isBot,
    budget: 100_000_000,
    team: { ...team, slots: filled },
    isEliminated: false,
  };
}

describe('auction engine transitions', () => {
  it('creates a 1 human + 2 bot match with shared formation and starting budgets', () => {
    const state = createMatch();

    expect(state.matchId).toBe('match-1');
    expect(state.phase).toBe('created');
    expect(state.seats).toHaveLength(3);
    expect(state.seats.filter((seat) => seat.isBot)).toHaveLength(2);
    expect(state.seats.every((seat) => seat.budget === 1_000_000_000)).toBe(true);
    expect(state.seats.every((seat) => seat.team.formation.name === '4-3-3')).toBe(true);
    expect(state).not.toHaveProperty('totalRounds');
  });

  it('creates a 3-human casual auction match without bots for matchmaking', () => {
    const state = createInitialAuctionMatch({
      matchId: 'match-human',
      humanUserId: 'user-1',
      humanDisplayName: 'One',
      humanPlayers: [
        { userId: 'user-1', displayName: 'One' },
        { userId: 'user-2', displayName: 'Two' },
        { userId: 'user-3', displayName: 'Three' },
      ],
      formation: '4-3-3',
      context: context(),
    });

    expect(state.seats).toHaveLength(3);
    expect(state.seats.filter((seat) => seat.isBot)).toHaveLength(0);
    expect(state.seats.map((seat) => seat.userId)).toEqual(['user-1', 'user-2', 'user-3']);
    expect(state.seats.map((seat) => seat.seatId)).toEqual(['seat-human-1', 'seat-human-2', 'seat-human-3']);
    expect(state.seats.every((seat) => seat.budget === 1_000_000_000)).toBe(true);
  });

  it('picks only positions that active players still need and that have available cards', () => {
    const state = createMatch(context(0.1));
    const pool: AuctionCardPool = {
      GK: [],
      DEF: [card('def-1', 'DEF')],
      MID: [],
      FWD: [],
    };

    expect(pickNextPosition(state, pool, context(0))).toBe('DEF');
  });

  it('starts a clue-reveal round with deterministic turn order and content-owned starting price', () => {
    const ctx = context();
    const state = createMatch(ctx);
    const footballer = card('low-opener', 'FWD', 250_000_000, 10_000_000);

    const roundState = startBiddingRound(state, 'FWD', footballer, state.seats, ctx);

    expect(roundState.phase).toBe('clue_reveal');
    expect(roundState.currentRound?.startingPrice).toBe(10_000_000);
    expect(roundState.currentRound?.turnOrder).toEqual(['seat-human', 'bot-seat-1', 'bot-seat-2']);
    expect(roundState.usedClueCardIds).toEqual(['low-opener-clue']);
  });

  it('reveals all clues before opening bidding with the long opener timer', () => {
    const state = startBiddingRound(createMatch(), 'FWD', card('fwd-1'), createMatch().seats, context());

    let next = revealNextClue(state, context());
    expect(next.currentRound?.clueRevealIndex).toBe(1);
    expect(() => startBidding(next, context())).toThrow('All clues must be revealed');

    next = revealNextClue(next, context());
    next = revealNextClue(next, context());
    next = startBidding(next, context());

    expect(next.phase).toBe('bidding');
    expect(next.currentRound?.currentTurnSeatId).toBe('seat-human');
    expect(next.currentRound?.turnEndsAt).toBe('2026-06-20T10:00:30.000Z');
  });

  it('blocks opener fold and auto-bids the opener on timeout', () => {
    const state = startReadyBiddingRound();

    expect(() => applyFold(state, 'seat-human', context())).toThrow('Opening bidder cannot fold');

    const next = applyTurnTimeout(state, context());
    expect(next.currentRound?.highestBidderSeatId).toBe('seat-human');
    expect(next.currentRound?.highestBid).toBe(30_000_000);
    expect(next.currentRound?.bids).toEqual([
      { seatId: 'seat-human', amount: 30_000_000, placedAt: '2026-06-20T10:00:00.000Z' },
    ]);
    expect(next.currentRound?.currentTurnSeatId).toBe('bot-seat-1');
    expect(next.currentRound?.turnEndsAt).toBe('2026-06-20T10:00:15.000Z');
  });

  it('auto-folds a non-opener timeout and skips the high bidder on the next turn', () => {
    const opened = applyTurnTimeout(startReadyBiddingRound(), context());

    const afterBotFold = applyTurnTimeout(opened, context());

    expect(afterBotFold.currentRound?.foldedSeatIds).toContain('bot-seat-1');
    expect(afterBotFold.currentRound?.currentTurnSeatId).toBe('bot-seat-2');
    expect(afterBotFold.currentRound?.currentTurnSeatId).not.toBe('seat-human');
  });

  it('skips a forced opener who cannot afford the starting price', () => {
    const state = withBudget(startReadyBiddingRound(card('expensive', 'FWD', 90_000_000, 50_000_000)), 'seat-human', 0);
    const clueRound = {
      ...state,
      phase: 'clue_reveal' as const,
      currentRound: {
        ...state.currentRound!,
        highestBidderSeatId: null,
        highestBid: 0,
        currentTurnSeatId: null,
      },
    };

    const bidding = startBidding(clueRound, context());

    expect(bidding.currentRound?.currentTurnSeatId).toBe('bot-seat-1');
  });

  it('rejects below-min, above-max, out-of-turn, and high-bidder self bids', () => {
    const state = startReadyBiddingRound(card('target', 'FWD', 120_000_000, 30_000_000));

    expect(() => applyBid(state, 'bot-seat-1', 30_000_000, context())).toThrow('Not this seat turn');
    expect(() => applyBid(state, 'seat-human', 29_999_999, context())).toThrow('Invalid auction bid');
    expect(() => applyBid(state, 'seat-human', 900_000_000, context())).toThrow('Invalid auction bid');

    const invalidSelfBid = {
      ...state,
      currentRound: {
        ...state.currentRound!,
        highestBidderSeatId: 'seat-human',
        highestBid: 30_000_000,
      },
    };
    expect(() => applyBid(invalidSelfBid, 'seat-human', 35_000_000, context())).toThrow(
      'Current high bidder cannot bid against themselves'
    );
  });

  it('resolves a round win, debits budget, assigns squad slot, and reveals identity only after resolution', () => {
    let state = applyBid(startReadyBiddingRound(card('target', 'FWD', 120_000_000, 30_000_000)), 'seat-human', 30_000_000, context());
    state = applyFold(state, 'bot-seat-1', context());
    state = applyFold(state, 'bot-seat-2', context());

    const human = state.seats.find((seat) => seat.seatId === 'seat-human')!;
    expect(state.phase).toBe('reveal');
    expect(state.currentRound?.revealed).toBe(true);
    expect(state.currentRound?.winnerSeatId).toBe('seat-human');
    expect(human.budget).toBe(970_000_000);
    expect(human.team.slots.FWD).toHaveLength(1);
    expect(human.team.slots.FWD[0].trueValue).toBe(120_000_000);
  });

  it('marks a player eliminated after assignment if remaining reserve cannot be met', () => {
    const state = createMatch();
    const lowBudgetSeat = { ...state.seats[0], budget: 30_000_000 };

    const [updated] = assignFootballerToSquad(
      [lowBudgetSeat],
      'seat-human',
      card('target', 'FWD', 120_000_000, 30_000_000),
      30_000_000
    );

    expect(updated.isEliminated).toBe(true);
  });

  it('resolves unsold when nobody can open', () => {
    let state = startBiddingRound(createMatch(), 'FWD', card('unsold', 'FWD', 80_000_000, 50_000_000), createMatch().seats, context());
    state = {
      ...state,
      seats: state.seats.map((seat) => ({ ...seat, budget: 0 })),
    };
    state = revealAllAndStart(state, context());

    expect(state.phase).toBe('created');
    expect(state.currentRound).toBeNull();
    expect(state.completedRounds.at(-1)?.winnerSeatId).toBeNull();
  });

  it('starts solo-pick when exactly one active player needs the position and selection costs no money', () => {
    const initial = createMatch();
    const soloReady = {
      ...initial,
      seats: initial.seats.map((seat) => seat.seatId === 'seat-human' ? seat : { ...seat, isEliminated: true }),
    };
    const pool: AuctionCardPool = {
      FWD: [card('revealed-option', 'FWD', 30_000_000), card('mystery-option', 'FWD', 90_000_000)],
    };

    const solo = advanceToNextRoundOrFinish(soloReady, pool, context());
    expect(solo.phase).toBe('solo_pick');
    expect(solo.soloPick?.optionA.type).toBe('revealed');
    expect(solo.soloPick?.optionB.type).toBe('mystery');
    expect(solo.soloPick?.optionB.clues).toHaveLength(3);

    const selected = selectSoloPickOption(solo, 'seat-human', 'B', context());
    const human = selected.seats.find((seat) => seat.seatId === 'seat-human')!;
    expect(human.budget).toBe(1_000_000_000);
    expect(human.team.slots.FWD[0].id).toBe('mystery-option');
    expect(selected.completedRounds.at(-1)?.winningBid).toBe(0);
  });

  it('advances after reveal, avoids used clue cards, and starts another available round', () => {
    const pool: AuctionCardPool = {
      FWD: [card('used', 'FWD'), card('next', 'FWD')],
    };
    let state = startReadyBiddingRound(pool.FWD![0]);
    state = applyBid(state, 'seat-human', 10_000_000, context());
    state = applyFold(state, 'bot-seat-1', context());
    state = applyFold(state, 'bot-seat-2', context());

    const next = advanceToNextRoundOrFinish(state, pool, context());

    expect(next.completedRounds).toHaveLength(1);
    expect(next.phase).toBe('clue_reveal');
    expect(next.currentRound?.footballer.id).toBe('next');
    expect(next.usedClueCardIds).toContain('used-clue');
    expect(next.usedClueCardIds).toContain('next-clue');
  });

  it('finishes when no needed position has available cards', () => {
    const state = advanceToNextRoundOrFinish(createMatch(), {}, context());

    expect(state.phase).toBe('finished');
    expect(state.rankings).toHaveLength(3);
  });

  it('ranks complete teams above incomplete teams, then by true squad value', () => {
    const incompleteHighValue = {
      ...createMatch().seats[0],
      seatId: 'incomplete',
      team: {
        ...createEmptyTeam('4-3-3'),
        slots: { ...createEmptyTeam('4-3-3').slots, FWD: [card('goat', 'FWD', 500_000_000)] },
      },
    };
    const completeLow = completeTeamPlayer('complete-low', 100_000_000);
    const completeHigh = completeTeamPlayer('complete-high', 200_000_000, true);
    const state = {
      ...createMatch(),
      seats: [incompleteHighValue, completeLow, completeHigh],
    };

    const finished = finishMatch(state, context());

    expect(finished.rankings?.map((rank) => rank.seatId)).toEqual([
      'complete-high',
      'complete-low',
      'incomplete',
    ]);
    expect(finished.rankings?.[0].totalTrueValue).toBeGreaterThan(finished.rankings?.[1].totalTrueValue ?? 0);
  });
});
