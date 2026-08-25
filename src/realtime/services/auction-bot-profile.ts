import { createHash } from 'node:crypto';
import { chemistryGainIfAdded } from '../../modules/auction/auction-chemistry.js';
import { getEmptySlots, getMaxBid } from '../../modules/auction/auction-rules.js';
import type { AuctionMatchState } from '../../modules/auction/auction-match-state.js';

/**
 * Bidding personality for one auction bot seat, derived from its persistent
 * roster profile (`synthetic_player_profiles`).
 *
 * Kept as a small POJO carried ON THE SEAT (not re-read from the DB per turn) so
 * the decision function stays pure and the harness can drive it deterministically:
 * same seed + same profile + same seat/round identity ⇒ same decisions (the
 * perception draws also hash the seatId and round).
 */
export interface AuctionBotProfile {
  /** 0..1 — higher = values players closer to their true worth. */
  baseSkill: number;
  /** 0..1 — higher = less turn-to-turn variance around that valuation. */
  consistency: number;
  /** Stable per-bot integer; drives hash-deterministic personality traits. */
  personalitySeed: number;
}

/**
 * Ephemeral defaults, retuned 2026-08-18 for the 350M profit×chemistry economy.
 * Scoring is (squad value − spend) × chemistry multiplier, so paying full
 * trueValue is a ZERO-profit move: the willingness band is centred BELOW
 * effective value (centre 0.85, ±0.25 → 0.60–1.10), leaving room for
 * human-like overpays at the top of the band without the systematic
 * value-or-above bidding of the old 1B-era constants.
 */
export const EPHEMERAL_AUCTION_BOT_WILLINGNESS_FLOOR = 0.6;
export const EPHEMERAL_AUCTION_BOT_WILLINGNESS_SPREAD = 0.5;
export const EPHEMERAL_AUCTION_BOT_JUMP_THRESHOLD = 0.8;
export const EPHEMERAL_AUCTION_BOT_CHEM_WEIGHT = 0.5;

export interface AuctionBotBehaviour {
  /** Willingness = effectiveValue * (floor + random() * spread), where
   *  effectiveValue folds in the card's marginal chemistry (see chemWeight). */
  willingnessFloor: number;
  willingnessSpread: number;
  /** random() >= this ⇒ jump-bid. Higher threshold = rarer jumps. */
  jumpThreshold: number;
  /** Think-time window for this bot's turns. */
  minThinkMs: number;
  maxThinkMs: number;
  /**
   * Fraction of the budget-derived hard cap this bot is willing to commit to a
   * single player. Disciplined (high-skill) bots hold more back for later slots.
   */
  budgetDiscipline: number;
  /**
   * 0..1 — how fully the bot prices in a card's marginal chemistry. Each squad
   * chemistry point is worth ~+10% of profit (multiplier = 1 + chem/10), so a
   * fully chem-aware bot values a +2-chem card ~20% above its raw trueValue.
   */
  chemWeight: number;
}

// Think-time band shared with the ephemeral defaults (auction-bot.service.ts).
const THINK_MIN_MS = 2_000;
const THINK_MAX_MS = 5_000;

export const EPHEMERAL_AUCTION_BOT_BEHAVIOUR: AuctionBotBehaviour = Object.freeze({
  willingnessFloor: EPHEMERAL_AUCTION_BOT_WILLINGNESS_FLOOR,
  willingnessSpread: EPHEMERAL_AUCTION_BOT_WILLINGNESS_SPREAD,
  jumpThreshold: EPHEMERAL_AUCTION_BOT_JUMP_THRESHOLD,
  minThinkMs: THINK_MIN_MS,
  maxThinkMs: THINK_MAX_MS,
  // Never the whole wallet on one name: with 350M across 7 slots, an
  // undisciplined early splurge is unrecoverable.
  budgetDiscipline: 0.8,
  chemWeight: EPHEMERAL_AUCTION_BOT_CHEM_WEIGHT,
});

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/**
 * Stable 0..1 trait from a bot's seed and a named trait axis. Hash-deterministic
 * (never RNG) so a given bot always has the same personality across matches and
 * replicas — the same construction the friend-request responder uses.
 */
export function seedTrait(personalitySeed: number, trait: string): number {
  const hash = createHash('md5').update(`${personalitySeed}:${trait}`).digest('hex');
  return Number.parseInt(hash.slice(0, 8), 16) / 0xffffffff;
}

/**
 * Relative estimation error bounds for a bot's read of a card's hidden value:
 * error = MAX − SKILL_CUT × base_skill. Every production seat carries a
 * profile (roster bots 0.05–0.90 skill, fabricated ephemeral 0.15–0.90), so
 * live errors span ±23%–±48.5%; the profile-less constant is a fallback for
 * seats fabricated without a profile.
 */
export const AUCTION_BOT_ESTIMATE_ERROR_MAX = 0.5;
export const AUCTION_BOT_ESTIMATE_ERROR_SKILL_CUT = 0.3;
export const EPHEMERAL_AUCTION_BOT_ESTIMATE_ERROR = 0.4;

/**
 * How often a bot spots that the concealed card links with its squad:
 * recognition = BASE + SKILL_SPAN × base_skill (profile-less: the EPHEMERAL
 * constant). A sharp scout reads the clues onto the right club most rounds; a
 * weak bot mostly bids the name.
 */
export const AUCTION_BOT_CHEM_RECOGNITION_BASE = 0.25;
export const AUCTION_BOT_CHEM_RECOGNITION_SKILL_SPAN = 0.5;
export const EPHEMERAL_AUCTION_BOT_CHEM_RECOGNITION = 0.4;

export interface AuctionBotCardPerception {
  trueValue: number;
  profile: AuctionBotProfile | null | undefined;
  /** Perception is per-SEAT: two bots sharing a personalitySeed (the DB does
   *  not enforce uniqueness) must still misjudge cards independently. */
  seatId: string;
  /** Stable identity of this look at this card: match + round + footballer. */
  estimateKey: string;
}

/** Stable 0..1 draw for one bot's read of one card along one perception axis. */
function perceptionUnit(
  profile: AuctionBotProfile | null | undefined,
  seatId: string,
  axis: string,
  estimateKey: string
): number {
  const identity = profile ? `${profile.personalitySeed}:${seatId}` : seatId;
  const hash = createHash('md5').update(`${identity}:${axis}:${estimateKey}`).digest('hex');
  return Number.parseInt(hash.slice(0, 8), 16) / 0xffffffff;
}

/**
 * What THIS bot believes the card is worth. Bots must not bid off the hidden
 * trueValue itself — that gives them a perfect stop-loss no human can match
 * (humans estimate from three clues) and made fallback opponents win >90% of
 * prod matches. The misjudgement is hash-derived (never RNG) from the seat and
 * the round, so it is stable for the whole bidding war and every replica
 * computes the same figure; a different round or a different seat gets an
 * independent error, so bots disagree with each other like humans do.
 */
export function perceivedCardValue(perception: AuctionBotCardPerception): number {
  const { profile } = perception;
  const errorMagnitude = profile
    ? AUCTION_BOT_ESTIMATE_ERROR_MAX - AUCTION_BOT_ESTIMATE_ERROR_SKILL_CUT * clamp01(profile.baseSkill)
    : EPHEMERAL_AUCTION_BOT_ESTIMATE_ERROR;
  const unit = perceptionUnit(profile, perception.seatId, 'estimate', perception.estimateKey);
  const multiplier = 1 + (2 * unit - 1) * errorMagnitude;
  return Math.max(1, Math.floor(perception.trueValue * multiplier));
}

/**
 * Whether THIS bot notices the concealed card's chemistry link this round.
 * The card's club/league/nation are hidden from humans until reveal, so a bot
 * that always prices marginal chemistry is peeking at them every round.
 * Hash-deterministic like the value estimate: stable within the round,
 * independent across rounds and seats.
 */
export function recognizesChemistryLink(perception: Omit<AuctionBotCardPerception, 'trueValue'>): boolean {
  const { profile } = perception;
  const recognition = profile
    ? AUCTION_BOT_CHEM_RECOGNITION_BASE + AUCTION_BOT_CHEM_RECOGNITION_SKILL_SPAN * clamp01(profile.baseSkill)
    : EPHEMERAL_AUCTION_BOT_CHEM_RECOGNITION;
  return perceptionUnit(profile, perception.seatId, 'chem', perception.estimateKey) < recognition;
}

/**
 * Translate a roster profile into concrete bidding behaviour.
 *
 * - base_skill tightens the willingness spread around the bot's PERCEIVED
 *   value of the card (see perceivedCardValue — skill also shrinks that
 *   estimate's error): a high-skill bot bids close to what it believes the
 *   player is worth, a low-skill bot swings wildly both under and over.
 * - consistency narrows that band further (a consistent bot repeats itself).
 * - personality_seed sets jump-bid propensity and the think-time window, so two
 *   bots of equal skill still feel like different people.
 * - budget discipline rises with skill: better bots keep money for later slots
 *   instead of emptying the wallet on one name.
 */
export function resolveAuctionBotBehaviour(profile: AuctionBotProfile | null | undefined): AuctionBotBehaviour {
  if (!profile) return EPHEMERAL_AUCTION_BOT_BEHAVIOUR;

  const skill = clamp01(profile.baseSkill);
  const consistency = clamp01(profile.consistency);

  // Profit-economy pricing (2026-08-18 retune): the score is profit ×
  // chemistry, so a rational buyer pays a MARGIN below effective value. The
  // band CENTRE drops with skill — a sharp bot hunts ~22% margins, a weak bot
  // hovers near break-even — and the WIDTH narrows with skill/consistency, so
  // weak bots still overpay at the top of their band (human-like mistakes)
  // while sharp bots almost never do.
  const centre = 0.88 - 0.10 * skill; // 0.88 (weak) … 0.78 (sharp)
  const skillWidth = 0.40 - 0.24 * skill;
  const halfWidth = skillWidth * (1 - 0.4 * consistency);
  const willingnessFloor = centre - halfWidth;
  const willingnessSpread = 2 * halfWidth;

  // Jump-bid propensity: 10%..40% of turns, fixed per bot by its seed.
  const jumpiness = seedTrait(profile.personalitySeed, 'jump');
  const jumpThreshold = 1 - (0.10 + 0.30 * jumpiness);

  // Think time: a per-bot window inside the shared band (fast bots ~1.2s, slow
  // bots up to ~5s), so bidding cadence varies by personality rather than by
  // being uniformly random for everyone.
  const pace = seedTrait(profile.personalitySeed, 'pace');
  const minThinkMs = Math.round(1_200 + 1_800 * pace);
  const maxThinkMs = Math.round(minThinkMs + 1_200 + 1_800 * (1 - pace));

  const budgetDiscipline = 0.55 + 0.35 * skill;

  // Chemistry awareness rises with skill: sharp bots build linked squads (they
  // will outbid for a card that completes a club/league/nation stack), weak
  // bots mostly chase names.
  const chemWeight = 0.3 + 0.7 * skill;

  return { willingnessFloor, willingnessSpread, jumpThreshold, minThinkMs, maxThinkMs, budgetDiscipline, chemWeight };
}

// The mystery option's expected worth to a bot that does NOT peek at the
// hidden trueValue (bots must gamble like humans): roughly the pool's fame-mix
// average. Deliberately a constant — reading the concealed value would make
// solo-pick bots omniscient.
export const AUCTION_BOT_MYSTERY_EXPECTED_VALUE_EUR = 35_000_000;

/**
 * Bot solo pick: compare the KNOWN option's profit (trueValue + its marginal
 * chemistry, minus the price it would ACTUALLY be charged) against the
 * mystery's expected profit. Pure AND state-deterministic: the personality
 * wobble is hash-derived from the pick itself, so every concurrent transition
 * driver computes the same choice for the same persisted solo state.
 *
 * The mystery side deliberately uses NO attribute of the concealed card — not
 * its value, club, league or nationality (chemistry expectation is zero): the
 * bot must gamble on exactly the information a human has.
 */
export function decideAuctionBotSoloPick(
  state: AuctionMatchState,
  seatId: string
): 'A' | 'B' {
  const pick = state.soloPick;
  const player = state.seats.find((seat) => seat.seatId === seatId);
  if (!pick || !player) return 'B';
  const behaviour = resolveAuctionBotBehaviour(player.botProfile);

  const optionProfit = (option: typeof pick.optionA, concealed: boolean): number => {
    const footballer = option.footballer;
    const chemGain = concealed ? 0 : chemistryGainIfAdded(player.team, footballer, pick.positionGroup);
    const baseValue = concealed ? AUCTION_BOT_MYSTERY_EXPECTED_VALUE_EUR : footballer.trueValue;
    const effective = baseValue * (1 + 0.1 * chemGain * behaviour.chemWeight);
    // Selection charges min(startingPrice, per-slot budget cap) — a
    // budget-constrained bot must not reject a bargain it would actually get
    // cheaply (auction-engine selectSoloPickOption uses the same cap).
    const charged = Math.max(0, Math.min(
      footballer.startingPrice,
      getMaxBid(player.budget, getEmptySlots(player.team))
    ));
    return effective - charged;
  };

  const profitA = optionProfit(pick.optionA, pick.optionA.type === 'mystery');
  const profitB = optionProfit(pick.optionB, pick.optionB.type === 'mystery');
  // Personality wobble, hash-derived from stable pick identity (never RNG):
  // wider-band (weaker) bots wobble up to ~+-25M of judgement error, and every
  // replica/replay reaches the same verdict for the same state.
  const seed = player.botProfile?.personalitySeed ?? 0;
  const wobbleTrait = seedTrait(seed, `solo:${pick.startedAt}:${pick.optionA.footballer.id}:${pick.optionB.footballer.id}`);
  const wobble = (wobbleTrait - 0.5) * behaviour.willingnessSpread * 100_000_000;
  return profitA + wobble > profitB ? 'A' : 'B';
}
