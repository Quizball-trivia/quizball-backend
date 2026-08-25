/**
 * Profile-parameterized bidding in decideAuctionBotAction.
 *
 * The function is pure: all randomness arrives through the injected `random`
 * (the harness seeds it via AuctionEngineContext), personality through the
 * seat's own botProfile, and the card-perception draws are hash-derived from
 * seat + round identity. So:
 *   - same seed + same profile + same seat/round ⇒ byte-identical decisions
 *   - a seat with NO profile uses the ephemeral band, anchored (like every
 *     seat) to its PERCEIVED value of the card, never the hidden trueValue
 *   - higher base_skill ⇒ a tighter willingness band AND a smaller
 *     perception error
 */
import { describe, expect, it } from 'vitest';
import '../setup.js';

import { createEmptyTeam } from '../../src/modules/auction/auction-rules.js';
import { MIN_BID_INCREMENT } from '../../src/modules/auction/auction.constants.js';
import { decideAuctionBotAction } from '../../src/realtime/services/auction-bot.service.js';
import {
  AUCTION_BOT_CHEM_RECOGNITION_BASE,
  AUCTION_BOT_CHEM_RECOGNITION_SKILL_SPAN,
  AUCTION_BOT_ESTIMATE_ERROR_MAX,
  AUCTION_BOT_ESTIMATE_ERROR_SKILL_CUT,
  EPHEMERAL_AUCTION_BOT_ESTIMATE_ERROR,
  decideAuctionBotSoloPick,
  perceivedCardValue,
  recognizesChemistryLink,
  resolveAuctionBotBehaviour,
  type AuctionBotProfile,
} from '../../src/realtime/services/auction-bot-profile.js';
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
  roundId?: string;
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
      roundId: options.roundId ?? 'r1',
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

// Skills stay inside the ranges production can actually produce: roster bots
// are constrained to 0.05–0.90, fabricated ephemeral profiles to 0.15–0.90.
const SKILLED: AuctionBotProfile = { baseSkill: 0.9, consistency: 0.8, personalitySeed: 11 };
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
function willingnessFor(profile: AuctionBotProfile | null, seed: number, roundId?: string): number {
  let low = 0;
  let high = TRUE_VALUE * 3;
  for (let i = 0; i < 40; i++) {
    const mid = Math.floor((low + high) / 2);
    const state = buildState({
      botProfile: profile,
      highestBid: mid,
      highestBidderSeatId: 'seat-human',
      budget: TRUE_VALUE * 100,
      roundId,
    });
    const decision = decideAuctionBotAction(state, 'seat-bot', seededRandom(seed));
    if (decision.kind === 'fold') high = mid;
    else low = mid;
  }
  return low;
}

/** The fixture bot's belief about the fixture card, matching the service's estimateKey. */
function fixturePerceivedValue(profile: AuctionBotProfile | null, roundId = 'r1'): number {
  return perceivedCardValue({
    trueValue: TRUE_VALUE,
    profile,
    seatId: 'seat-bot',
    estimateKey: `m1:${roundId}:f1`,
  });
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

  it('different profiles diverge on the same seed', () => {
    // At a price well above true value the skilled bot folds where the wild
    // one may not — scan rounds until the divergence shows up (the wild bot
    // only chases when its perception overrates the card).
    const diverged = Array.from({ length: 30 }, (_, i) => `round-${i}`).some((roundId) => {
      const kinds = [SKILLED, UNSKILLED].map((profile) => {
        const state = buildState({
          botProfile: profile, highestBid: 130_000_000, highestBidderSeatId: 'seat-human', roundId,
        });
        return decideAuctionBotAction(state, 'seat-bot', seededRandom(1920)).kind;
      });
      return new Set(kinds).size > 1;
    });
    expect(diverged).toBe(true);
  });
});

describe('skill → precision', () => {
  it('a high-skill bot hunts a profit margin: willingness stays BELOW its perceived value', () => {
    // Profit economy: the score is (value - spend) x chemistry, so a sharp bot
    // pays a margin under what it BELIEVES the card is worth on every sample,
    // while a weak bot's wide band still overpays at its top end. Relative to
    // the hidden trueValue the sharp bot can now be wrong too — its belief
    // carries a (small) estimation error like everyone else's.
    const seeds = Array.from({ length: 60 }, (_, i) => i * 7919 + 1);
    const skilled = seeds.map((s) => willingnessFor(SKILLED, s));
    const wild = seeds.map((s) => willingnessFor(UNSKILLED, s));

    for (const willingness of skilled) {
      expect(willingness).toBeLessThan(fixturePerceivedValue(SKILLED));
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(skilled) / fixturePerceivedValue(SKILLED)).toBeLessThan(
      mean(wild) / fixturePerceivedValue(UNSKILLED) + MIN_BID_INCREMENT / TRUE_VALUE
    );
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
    // Profit-economy ephemeral band: willingness = PERCEIVED value * (0.60 +
    // rand*0.50) ⇒ within [0.60, 1.10] of what the bot believes the card is
    // worth (its belief, not the hidden trueValue, anchors the band).
    //
    // The measured quantity is the highest STANDING bid the bot will still raise
    // over, and a raise costs MIN_BID_INCREMENT, so the fold boundary sits one
    // increment BELOW willingness. Widen the band by exactly that increment.
    const perceived = fixturePerceivedValue(null);
    const seeds = Array.from({ length: 40 }, (_, i) => i * 104729 + 3);
    for (const seed of seeds) {
      const boundary = willingnessFor(null, seed);
      expect(boundary).toBeGreaterThanOrEqual(Math.floor(perceived * 0.6) - MIN_BID_INCREMENT - 2);
      expect(boundary).toBeLessThanOrEqual(Math.ceil(perceived * 1.1) + 2);
    }
  });

  it('still folds when the standing bid is far beyond any plausible willingness', () => {
    const state = buildState({ botProfile: null, highestBid: TRUE_VALUE * 2, highestBidderSeatId: 'seat-human' });
    expect(decideAuctionBotAction(state, 'seat-bot', seededRandom(5)).kind).toBe('fold');
  });
});

describe('perceived value (bots must not peek at trueValue)', () => {
  const roundIds = Array.from({ length: 30 }, (_, i) => `round-${i}`);

  it('is a pure function of (seat, round): stable across calls, so every replica agrees', () => {
    const a = fixturePerceivedValue(SKILLED);
    const b = fixturePerceivedValue(SKILLED);
    expect(a).toBe(b);
    // The estimate cannot flip-flop between turns of one bidding war. (The
    // margin draw on top of it is still per-turn RNG, as it always was.)
    expect(willingnessFor(SKILLED, 7)).toBe(willingnessFor(SKILLED, 7));
  });

  it('honours the exact skill-scaled error formula and actually uses the band', () => {
    const manyRounds = Array.from({ length: 300 }, (_, i) => `round-${i}`);
    const errorBound = (profile: AuctionBotProfile | null) => profile
      ? AUCTION_BOT_ESTIMATE_ERROR_MAX - AUCTION_BOT_ESTIMATE_ERROR_SKILL_CUT * profile.baseSkill
      : EPHEMERAL_AUCTION_BOT_ESTIMATE_ERROR;
    for (const profile of [SKILLED, UNSKILLED, null]) {
      const bound = errorBound(profile);
      const signedErrors = manyRounds.map((r) => fixturePerceivedValue(profile, r) / TRUE_VALUE - 1);
      for (const error of signedErrors) expect(Math.abs(error)).toBeLessThanOrEqual(bound + 1e-6);
      // BOTH tails must be exercised, not just never exceeded — a constant
      // multiplier of 1.0 (or a one-sided estimator) would silently reinstate
      // a form of the trueValue oracle.
      expect(Math.max(...signedErrors)).toBeGreaterThan(bound * 0.9);
      expect(Math.min(...signedErrors)).toBeLessThan(-bound * 0.9);
    }
  });

  it('varies between rounds and between seats (they misjudge independently)', () => {
    const estimates = new Set(roundIds.map((r) => fixturePerceivedValue(UNSKILLED, r)));
    expect(estimates.size).toBeGreaterThan(10);
    // Perception is per-SEAT even for profiled bots: personality seeds are not
    // unique in the DB, and two bots sharing one must not share every
    // misjudgement.
    const sameSeedOtherSeat = perceivedCardValue({
      trueValue: TRUE_VALUE, profile: UNSKILLED, seatId: 'seat-other', estimateKey: 'm1:r1:f1',
    });
    expect(sameSeedOtherSeat).not.toBe(fixturePerceivedValue(UNSKILLED));
    const profilelessOtherSeat = perceivedCardValue({
      trueValue: TRUE_VALUE, profile: null, seatId: 'seat-other', estimateKey: 'm1:r1:f1',
    });
    expect(profilelessOtherSeat).not.toBe(fixturePerceivedValue(null));
  });

  it('spots chemistry links at the skill-scaled recognition rate, deterministically', () => {
    const manyRounds = Array.from({ length: 1500 }, (_, i) => `round-${i}`);
    const rateFor = (profile: AuctionBotProfile) => {
      const hits = manyRounds.filter((r) => recognizesChemistryLink({
        profile, seatId: 'seat-bot', estimateKey: `m1:${r}:f1`,
      })).length;
      return hits / manyRounds.length;
    };
    for (const profile of [SKILLED, UNSKILLED]) {
      const expected = AUCTION_BOT_CHEM_RECOGNITION_BASE + AUCTION_BOT_CHEM_RECOGNITION_SKILL_SPAN * profile.baseSkill;
      expect(Math.abs(rateFor(profile) - expected)).toBeLessThan(0.06);
    }
    expect(rateFor(SKILLED)).toBeGreaterThan(rateFor(UNSKILLED));
    expect(recognizesChemistryLink({ profile: SKILLED, seatId: 'seat-bot', estimateKey: 'm1:r1:f1' }))
      .toBe(recognizesChemistryLink({ profile: SKILLED, seatId: 'seat-bot', estimateKey: 'm1:r1:f1' }));
  });

  it('bots are honestly baitable: some rounds they hold past trueValue, others they fold below any margin', () => {
    // The old code anchored the whole band to the hidden trueValue, so a
    // bot's stop boundary could never leave [floor, floor+spread] x true
    // worth (~0.52-1.23x for this wild profile). With beliefs replacing
    // truth, a weak bot must sometimes chase a card past that OLD ceiling AND
    // sometimes fold below the OLD floor — excursions that were impossible
    // with the oracle, exactly the human-like misreads the fairness fix
    // exists to create.
    // Seeds chosen for extreme FIRST draws (the willingness draw): 1920 ⇒
    // ~0.98 (top of band), 1972 ⇒ ~0.0003 (bottom) — the LCG's first draw
    // barely varies across small consecutive seeds.
    const oldBand = resolveAuctionBotBehaviour(UNSKILLED);
    const oldCeiling = TRUE_VALUE * (oldBand.willingnessFloor + oldBand.willingnessSpread);
    const oldFloor = TRUE_VALUE * oldBand.willingnessFloor;
    const boundaries = roundIds.flatMap((r) =>
      [1920, 1972].map((seed) => willingnessFor(UNSKILLED, seed, r))
    );
    expect(boundaries.some((b) => b > oldCeiling)).toBe(true);
    expect(boundaries.some((b) => b < oldFloor - MIN_BID_INCREMENT)).toBe(true);
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

  // Chemistry recognition is a per-round hash draw — pin a round where this
  // bot DOES spot the link, so the test exercises the priced-in path.
  const CHEM_ROUND = Array.from({ length: 50 }, (_, i) => `chem-round-${i}`)
    .find((r) => recognizesChemistryLink({ profile: CHEM_PROFILE, seatId: 'seat-bot', estimateKey: `m1:${r}:f1` }))!;

  function stateWithSquadmate(cardClub: string | null, roundId: string = CHEM_ROUND): AuctionMatchState {
    // Raising over the standing bid must cost exactly 95% of what THIS bot
    // believes the card is worth (the pre-perception fixture pinned 85M
    // standing + 10M raise against a 100M value; anchoring to the perceived
    // value keeps that geometry: above the sharp bot's raw band top ~0.91,
    // inside its chem-boosted top ~1.08).
    const standingBid = Math.floor(fixturePerceivedValue(CHEM_PROFILE, roundId) * 0.95) - MIN_BID_INCREMENT;
    const state = buildState({
      botProfile: CHEM_PROFILE,
      highestBid: standingBid,
      highestBidderSeatId: 'seat-human',
      roundId,
    });
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
    // Raising costs 95% of the bot's perceived value, above its whole margin
    // band on the raw card (tops out ~91%) — the UNLINKED card is always a
    // fold. A same-club link (+2 squad chemistry ≈ +18% effective value at
    // high chemWeight) lifts the band top past ~108%, so a healthy share of
    // seeds flip to a raise. Chemistry may only ever raise willingness, never
    // lower it.
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

  it('an UNRECOGNIZED link prices exactly like no link at all', () => {
    // The card's club is concealed until reveal, so on rounds where the
    // recognition draw misses, a linked card must be indistinguishable from
    // an unlinked one — if the service quietly went back to always pricing
    // chemistry, this fails.
    const blindRound = Array.from({ length: 50 }, (_, i) => `chem-blind-${i}`)
      .find((r) => !recognizesChemistryLink({ profile: CHEM_PROFILE, seatId: 'seat-bot', estimateKey: `m1:${r}:f1` }))!;
    for (let seed = 1; seed <= 60; seed += 1) {
      const rng = seededRandom(seed * 2654435761 + 97);
      rng(); rng(); rng();
      const rngB = seededRandom(seed * 2654435761 + 97);
      rngB(); rngB(); rngB();
      const linked = decideAuctionBotAction(stateWithSquadmate('Real Madrid', blindRound), 'seat-bot', rng);
      const unlinked = decideAuctionBotAction(stateWithSquadmate('Chelsea', blindRound), 'seat-bot', rngB);
      expect(linked).toEqual(unlinked);
    }
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

  it('takes the revealed bargain over an expensive mystery, deterministically', () => {
    // Known: 80M for 10M (=70M profit). Mystery: ~35M expected for 50M (=-15M).
    // The 85M gap dwarfs personality wobble → A. No RNG parameter exists any
    // more: the same persisted pick must yield the same verdict on every
    // replica (the wobble is hash-derived from the pick itself).
    const state = soloState({ value: 80_000_000, price: 10_000_000 }, { price: 50_000_000 });
    expect(decideAuctionBotSoloPick(state, 'seat-bot')).toBe('A');
    expect(decideAuctionBotSoloPick(state, 'seat-bot')).toBe(decideAuctionBotSoloPick(state, 'seat-bot'));
  });

  it('takes the mystery when the revealed option is clearly overpriced', () => {
    // Known: 20M for 50M (=-30M). Mystery: ~35M expected for 10M (=+25M).
    expect(decideAuctionBotSoloPick(soloState({ value: 20_000_000, price: 50_000_000 }, { price: 10_000_000 }), 'seat-bot')).toBe('B');
  });

  it('mystery judgement ignores the concealed card entirely (no peeking)', () => {
    // Two mysteries identical to a HUMAN (same price) but with wildly
    // different hidden values/links must produce the same choice.
    const modest = soloState({ value: 80_000_000, price: 10_000_000 }, { price: 50_000_000 });
    const jackpot = soloState({ value: 80_000_000, price: 10_000_000 }, { price: 50_000_000 });
    jackpot.soloPick!.optionB.footballer.trueValue = 500_000_000;
    jackpot.soloPick!.optionB.footballer.currentClub = 'Real Madrid';
    jackpot.soloPick!.optionB.footballer.nationality = 'Spain';
    expect(decideAuctionBotSoloPick(jackpot, 'seat-bot')).toBe(decideAuctionBotSoloPick(modest, 'seat-bot'));
  });

  it('uses the CAPPED charge for a budget-constrained bot, not the sticker price', () => {
    // Sticker 120M known bargain vs cheap mystery — but the bot only has 30M
    // left, so selection would charge it far less than sticker. It must still
    // see option A as a bargain (120M value for a <=30M real charge).
    const state = soloState({ value: 120_000_000, price: 120_000_000 }, { price: 10_000_000 });
    const bot = state.seats.find((seat) => seat.seatId === 'seat-bot')!;
    bot.budget = 30_000_000;
    expect(decideAuctionBotSoloPick(state, 'seat-bot')).toBe('A');
  });
});
