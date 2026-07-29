import { createHash } from 'node:crypto';

/**
 * Bidding personality for one auction bot seat, derived from its persistent
 * roster profile (`synthetic_player_profiles`).
 *
 * Kept as a small POJO carried ON THE SEAT (not re-read from the DB per turn) so
 * the decision function stays pure and the harness can drive it deterministically:
 * same seed + same profile ⇒ same decisions.
 */
export interface AuctionBotProfile {
  /** 0..1 — higher = values players closer to their true worth. */
  baseSkill: number;
  /** 0..1 — higher = less turn-to-turn variance around that valuation. */
  consistency: number;
  /** Stable per-bot integer; drives hash-deterministic personality traits. */
  personalitySeed: number;
}

/** Heuristic defaults reproducing the pre-persistent ephemeral behaviour exactly. */
export const EPHEMERAL_AUCTION_BOT_WILLINGNESS_FLOOR = 0.75;
export const EPHEMERAL_AUCTION_BOT_WILLINGNESS_SPREAD = 0.55;
export const EPHEMERAL_AUCTION_BOT_JUMP_THRESHOLD = 0.8;

export interface AuctionBotBehaviour {
  /** Willingness = trueValue * (floor + random() * spread). */
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
  budgetDiscipline: 1,
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
 * Translate a roster profile into concrete bidding behaviour.
 *
 * - base_skill tightens the willingness spread AROUND true value: a high-skill
 *   bot bids close to what a player is really worth, a low-skill bot swings
 *   wildly both under and over. The band is centred on 1.0 * trueValue so skill
 *   changes precision, not systematic generosity.
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

  // Half-width of the willingness band around true value. Widest (±0.40) for an
  // unskilled, erratic bot; tightest (±0.08) for a skilled, consistent one.
  const skillWidth = 0.40 - 0.24 * skill;
  const halfWidth = skillWidth * (1 - 0.4 * consistency);
  const willingnessFloor = 1 - halfWidth;
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

  const budgetDiscipline = 0.55 + 0.45 * skill;

  return { willingnessFloor, willingnessSpread, jumpThreshold, minThinkMs, maxThinkMs, budgetDiscipline };
}
