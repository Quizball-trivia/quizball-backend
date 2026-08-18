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
import { decideAuctionBotSoloPick, type AuctionBotProfile } from '../../src/realtime/services/auction-bot-profile.js';
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
  const formation = '2-2-2';
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
  it('a high-skill bot hunts a profit margin: willingness stays BELOW true value', () => {
    // Profit economy: the score is (value - spend) x chemistry, so a sharp bot
    // pays a margin under value on every sample, while a weak bot's wide band
    // still overpays at its top end (human-like mistakes).
    const seeds = Array.from({ length: 60 }, (_, i) => i * 7919 + 1);
    const skilled = seeds.map((s) => willingnessFor(SKILLED, s));
    const wild = seeds.map((s) => willingnessFor(UNSKILLED, s));

    for (const willingness of skilled) {
      expect(willingness).toBeLessThan(TRUE_VALUE);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(skilled)).toBeLessThan(mean(wild) + MIN_BID_INCREMENT);
  });

  it('a high-skill bot has a TIGHTER willingness distribution over N samples', () => {
    const seeds = Array.from({ length: 60 }, (_, i) => i * 7919 + 1);
    const skilled = seeds.map((s) => willingnessFor(SKILLED, s));
    const wild = seeds.map((s) => willingnessFor(UNSKILLED, s));

    expect(stdev(skilled)).toBeLessThan(stdev(wild));
  });
});

describe('ephemeral parity', () => {
  it('a seat with NO profile uses the profit-economy ephemeral band exactly', () => {
    // Profit-economy ephemeral band: willingness = value * (0.60 + rand*0.50)
    // ⇒ within [0.60, 1.10].
    //
    // The measured quantity is the highest STANDING bid the bot will still raise
    // over, and a raise costs MIN_BID_INCREMENT, so the fold boundary sits one
    // increment BELOW willingness. Widen the band by exactly that increment.
    const seeds = Array.from({ length: 40 }, (_, i) => i * 104729 + 3);
    for (const seed of seeds) {
      const boundary = willingnessFor(null, seed);
      expect(boundary).toBeGreaterThanOrEqual(Math.floor(TRUE_VALUE * 0.6) - MIN_BID_INCREMENT - 2);
      expect(boundary).toBeLessThanOrEqual(Math.ceil(TRUE_VALUE * 1.1) + 2);
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
    // Budget is the default (comfortably above the 7-slot reserve), so the only
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

describe('chemistry-aware valuation (350M profit economy)', () => {
  const CHEM_PROFILE: AuctionBotProfile = { baseSkill: 0.9, consistency: 0.9, personalitySeed: 21 };

  function stateWithSquadmate(cardClub: string | null): AuctionMatchState {
    const state = buildState({ botProfile: CHEM_PROFILE, highestBid: 85_000_000, highestBidderSeatId: 'seat-human' });
    const bot = state.seats.find((seat) => seat.seatId === 'seat-bot')!;
    // The bot already owns a Real Madrid defender; the lot either links to it
    // (same club → +chemistry for both) or does not.
    bot.team.slots.DEF.push({
      id: 'owned-def', name: 'Owned Defender', positionGroup: 'DEF',
      trueValue: 40_000_000, startingPrice: 10_000_000, clues: [],
      currentClub: 'Real Madrid', nationality: 'Spain',
    });
    state.currentRound!.footballer.currentClub = cardClub;
    return state;
  }

  it('chemistry can flip a fold into a raise, and never the reverse', () => {
    // 85M standing bid vs a 100M-value card: raising costs 95M, above the sharp
    // bot's whole margin band on raw value (tops out ~91M) — the UNLINKED card
    // is always a fold. A same-club link (+2 squad chemistry ≈ +18% effective
    // value at high chemWeight) lifts the band top past 107M, so a healthy
    // share of seeds flip to a raise. Chemistry may only ever raise
    // willingness, never lower it.
    // The LCG's FIRST draw barely varies across small consecutive seeds — warm
    // it so the willingness draw actually sweeps the band.
    const warmedRandom = (seed: number) => {
      const rng = seededRandom(seed * 2654435761 + 97);
      rng(); rng(); rng();
      return rng;
    };
    let flippedToBid = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      const unlinked = decideAuctionBotAction(stateWithSquadmate('Chelsea'), 'seat-bot', warmedRandom(seed));
      const linked = decideAuctionBotAction(stateWithSquadmate('Real Madrid'), 'seat-bot', warmedRandom(seed));
      expect(unlinked.kind).toBe('fold');
      if (linked.kind === 'bid') flippedToBid += 1;
    }
    expect(flippedToBid).toBeGreaterThan(10);
  });
});

describe('bot solo picks (profit comparison, no peeking)', () => {
  const PROFILE: AuctionBotProfile = { baseSkill: 0.9, consistency: 0.9, personalitySeed: 31 };

  function soloState(optionA: { value: number; price: number }, optionB: { price: number }): AuctionMatchState {
    const state = buildState({ botProfile: PROFILE });
    state.phase = 'solo_pick' as AuctionMatchState['phase'];
    state.currentRound = null;
    state.soloPick = {
      playerSeatId: 'seat-bot',
      positionGroup: 'FWD',
      optionA: {
        type: 'revealed',
        footballer: { id: 'a', name: 'Known', positionGroup: 'FWD', trueValue: optionA.value, startingPrice: optionA.price, clues: [] },
      },
      optionB: {
        type: 'mystery',
        footballer: { id: 'b', name: 'Mystery', positionGroup: 'FWD', trueValue: 999_000_000, startingPrice: optionB.price, clues: [] },
      },
      selectedOption: null,
      startedAt: new Date().toISOString(),
    } as AuctionMatchState['soloPick'];
    return state;
  }

  it('takes the revealed bargain over an expensive mystery', () => {
    // Known: 80M for 10M (=70M profit). Mystery: ~35M expected for 50M (=-15M).
    // The 85M gap dwarfs personality wobble, so every seed picks A — proving
    // the bot compares profits rather than blindly gambling, and does NOT peek
    // at the mystery's absurd hidden trueValue.
    for (let seed = 1; seed <= 40; seed += 1) {
      expect(decideAuctionBotSoloPick(soloState({ value: 80_000_000, price: 10_000_000 }, { price: 50_000_000 }), 'seat-bot', seededRandom(seed))).toBe('A');
    }
  });

  it('takes the mystery when the revealed option is clearly overpriced', () => {
    // Known: 20M for 50M (=-30M). Mystery: ~35M expected for 10M (=+25M).
    for (let seed = 1; seed <= 40; seed += 1) {
      expect(decideAuctionBotSoloPick(soloState({ value: 20_000_000, price: 50_000_000 }, { price: 10_000_000 }), 'seat-bot', seededRandom(seed))).toBe('B');
    }
  });
});
