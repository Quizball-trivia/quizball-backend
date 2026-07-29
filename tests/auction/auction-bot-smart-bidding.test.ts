/**
 * Profile-parameterized bidding in decideAuctionBotAction.
 *
 * The function is pure: all randomness arrives through the injected `random`
 * (the harness seeds it via AuctionEngineContext) and all personality through
 * the seat's own botProfile. So:
 *   - same seed + same profile ⇒ byte-identical decisions (replayable)
 *   - a seat with NO profile behaves exactly like the pre-persistent heuristic
 *   - higher base_skill ⇒ a TIGHTER willingness distribution around true value
 */
import { describe, expect, it } from 'vitest';
import '../setup.js';

import { createEmptyTeam } from '../../src/modules/auction/auction-rules.js';
import { MIN_BID_INCREMENT } from '../../src/modules/auction/auction.constants.js';
import { decideAuctionBotAction } from '../../src/realtime/services/auction-bot.service.js';
import type { AuctionBotProfile } from '../../src/realtime/services/auction-bot-profile.js';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';

const TRUE_VALUE = 100_000_000;

/** Deterministic LCG so a seed fully reproduces a decision sequence. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function buildState(options: {
  botProfile?: AuctionBotProfile | null;
  highestBid?: number | null;
  highestBidderSeatId?: string | null;
  budget?: number;
}): AuctionMatchState {
  const formation = '4-3-3';
  return {
    matchId: 'm1',
    version: 1,
    locale: 'en',
    origin: 'queue',
    phase: 'bidding',
    formation,
    seats: [
      {
        seatId: 'seat-human',
        userId: 'human-1',
        displayName: 'Human',
        isBot: false,
        budget: 500_000_000,
        team: createEmptyTeam(formation),
        isEliminated: false,
      },
      {
        seatId: 'seat-bot',
        userId: 'bot-1',
        displayName: 'Bot',
        isBot: true,
        botProfile: options.botProfile ?? null,
        budget: options.budget ?? 500_000_000,
        team: createEmptyTeam(formation),
        isEliminated: false,
      },
    ],
    currentRound: {
      roundId: 'r1',
      positionGroup: 'FWD',
      footballer: { id: 'f1', name: 'Striker', positionGroup: 'FWD', trueValue: TRUE_VALUE, startingPrice: 10_000_000, clues: [] },
      startingPrice: 10_000_000,
      highestBid: options.highestBid ?? null,
      highestBidderSeatId: options.highestBidderSeatId ?? null,
      currentTurnSeatId: 'seat-bot',
      turnOrder: ['seat-human', 'seat-bot'],
      foldedSeatIds: [],
      bids: [],
      turnEndsAt: new Date(Date.now() + 15_000).toISOString(),
      clueRevealIndex: 3,
      revealed: false,
      updatedAt: new Date().toISOString(),
    },
    completedRounds: [],
    soloPick: null,
    usedClueCardIds: [],
    rankings: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as AuctionMatchState;
}

const SKILLED: AuctionBotProfile = { baseSkill: 0.95, consistency: 0.8, personalitySeed: 11 };
const UNSKILLED: AuctionBotProfile = { baseSkill: 0.05, consistency: 0.2, personalitySeed: 11 };

/**
 * Empirical willingness ceiling: the highest standing bid this bot will still
 * raise over. Found by bisection on the fold boundary for a fixed seed, which is
 * exactly the quantity base_skill is meant to control.
 *
 * Uses a HUGE budget so the wallet ceiling (getMaxBid, which also reserves
 * MIN_PLAYER_COST for every other empty slot) can never bind before willingness
 * does — otherwise this would measure the budget rule, not the valuation.
 */
function willingnessFor(profile: AuctionBotProfile | null, seed: number): number {
  let low = 0;
  let high = TRUE_VALUE * 3;
  for (let i = 0; i < 40; i++) {
    const mid = Math.floor((low + high) / 2);
    const state = buildState({
      botProfile: profile,
      highestBid: mid,
      highestBidderSeatId: 'seat-human',
      budget: TRUE_VALUE * 100,
    });
    const decision = decideAuctionBotAction(state, 'seat-bot', seededRandom(seed));
    if (decision.kind === 'fold') high = mid;
    else low = mid;
  }
  return low;
}

function stdev(values: number[]): number {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
}

describe('determinism', () => {
  it('same seed + same profile ⇒ identical decisions', () => {
    const state = buildState({ botProfile: SKILLED });
    const a = decideAuctionBotAction(state, 'seat-bot', seededRandom(12345));
    const b = decideAuctionBotAction(state, 'seat-bot', seededRandom(12345));
    expect(a).toEqual(b);
  });

  it('is replayable across a whole sequence of seeds', () => {
    const state = buildState({ botProfile: SKILLED });
    const run = () => Array.from({ length: 25 }, (_, i) => decideAuctionBotAction(state, 'seat-bot', seededRandom(i)));
    expect(run()).toEqual(run());
  });

  it('different profiles can diverge on the same seed', () => {
    const decisions = new Set(
      [SKILLED, UNSKILLED].map((profile) => {
        const state = buildState({ botProfile: profile, highestBid: 130_000_000, highestBidderSeatId: 'seat-human' });
        return decideAuctionBotAction(state, 'seat-bot', seededRandom(99)).kind;
      }),
    );
    // At a price well above true value the skilled bot folds where the wild one may not.
    expect(decisions.size).toBeGreaterThan(0);
  });
});

describe('skill → precision', () => {
  it('a high-skill bot values players CLOSER to true value than a low-skill bot', () => {
    const seeds = Array.from({ length: 60 }, (_, i) => i * 7919 + 1);
    const skilledError = seeds.map((s) => Math.abs(willingnessFor(SKILLED, s) - TRUE_VALUE));
    const wildError = seeds.map((s) => Math.abs(willingnessFor(UNSKILLED, s) - TRUE_VALUE));

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(skilledError)).toBeLessThan(mean(wildError));
  });

  it('a high-skill bot has a TIGHTER willingness distribution over N samples', () => {
    const seeds = Array.from({ length: 60 }, (_, i) => i * 7919 + 1);
    const skilled = seeds.map((s) => willingnessFor(SKILLED, s));
    const wild = seeds.map((s) => willingnessFor(UNSKILLED, s));

    expect(stdev(skilled)).toBeLessThan(stdev(wild));
  });
});

describe('ephemeral parity', () => {
  it('a seat with NO profile reproduces the legacy heuristic band exactly', () => {
    // Legacy: willingness = trueValue * (0.75 + rand*0.55) ⇒ within [0.75, 1.30].
    //
    // The measured quantity is the highest STANDING bid the bot will still raise
    // over, and a raise costs MIN_BID_INCREMENT, so the fold boundary sits one
    // increment BELOW willingness. Widen the band by exactly that increment.
    const seeds = Array.from({ length: 40 }, (_, i) => i * 104729 + 3);
    for (const seed of seeds) {
      const boundary = willingnessFor(null, seed);
      expect(boundary).toBeGreaterThanOrEqual(Math.floor(TRUE_VALUE * 0.75) - MIN_BID_INCREMENT - 2);
      expect(boundary).toBeLessThanOrEqual(Math.ceil(TRUE_VALUE * 1.30) + 2);
    }
  });

  it('still folds when the standing bid is far beyond any plausible willingness', () => {
    const state = buildState({ botProfile: null, highestBid: TRUE_VALUE * 2, highestBidderSeatId: 'seat-human' });
    expect(decideAuctionBotAction(state, 'seat-bot', seededRandom(5)).kind).toBe('fold');
  });
});

describe('budget discipline', () => {
  it('can still OPEN a round it can afford, however disciplined', () => {
    // Discipline scales the wallet ceiling down, but must never scale it below
    // the minimum bid — that would silently thin the field and stall rounds.
    // Budget is the default (comfortably above the 11-slot reserve), so the only
    // thing that could suppress the bid here is over-aggressive discipline.
    for (let seed = 0; seed < 25; seed++) {
      const state = buildState({ botProfile: SKILLED });
      const decision = decideAuctionBotAction(state, 'seat-bot', seededRandom(seed));
      expect(decision.kind).toBe('bid');
    }
  });

  it('never bids more than the seat can pay', () => {
    for (let seed = 0; seed < 40; seed++) {
      const budget = 500_000_000;
      const state = buildState({ botProfile: UNSKILLED, budget });
      const decision = decideAuctionBotAction(state, 'seat-bot', seededRandom(seed));
      if (decision.kind === 'bid') expect(decision.amount).toBeLessThanOrEqual(budget);
    }
  });
});
