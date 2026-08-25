import { getRandom } from '../../core/rng.js';
import { harnessDelayMs, isHarnessFastTimers } from '../../core/harness-timing.js';
import {
  MIN_BID_INCREMENT,
} from '../../modules/auction/auction.constants.js';
import {
  applyBid,
  applyFold,
  type AuctionEngineContext,
} from '../../modules/auction/auction-engine.js';
import {
  type AuctionMatchState,
} from '../../modules/auction/auction-match-state.js';
import { getEmptySlots, getMaxBid, getMinBid, needsPosition } from '../../modules/auction/auction-rules.js';
import { chemistryGainIfAdded } from '../../modules/auction/auction-chemistry.js';
import {
  auctionStateStore,
  saveAuctionMatchMutation,
  skipAuctionMatchMutation,
} from '../../modules/auction/auction-state.store.js';
import {
  scheduleRealtimeTimer,
  type RealtimeTimerPayload,
} from '../realtime-timer-scheduler.js';
import type { QuizballServer } from '../socket-server.js';
import { advanceAuctionMatchFlowAfterMutation } from './auction-match-flow.service.js';
import {
  buildBidAcceptedPayload,
  buildFoldAcceptedPayload,
  buildTurnStartedPayload,
} from './auction-realtime-payloads.js';
import { resolveRealtimeAuctionContext } from './auction-engine-context.js';
import {
  perceivedCardValue,
  recognizesChemistryLink,
  resolveAuctionBotBehaviour,
  type AuctionBotProfile,
} from './auction-bot-profile.js';

// Bots deliberate long enough for the bidding to read as a back-and-forth
// rather than resolving the instant a turn opens. Kept comfortably under
// RAISE_TURN_MS so a bot never runs its own turn down to the auto-fold.
export const AUCTION_BOT_MIN_THINK_MS = 2_000;
export const AUCTION_BOT_MAX_THINK_MS = 5_000;

export type AuctionBotActionTimerPayload = Extract<RealtimeTimerPayload, { kind: 'auction_bot_action' }>;

export interface AuctionBotTimerOptions {
  now?: Date;
  context?: AuctionEngineContext;
}

type AuctionBotActionOutcome =
  | { kind: 'noop'; reason: string }
  | { kind: 'bot_bid'; state: AuctionMatchState; seatId: string; amount: number }
  | { kind: 'bot_fold'; state: AuctionMatchState; seatId: string };

type BotDecision =
  | { kind: 'bid'; amount: number }
  | { kind: 'fold' }
  | { kind: 'noop'; reason: string };

export function auctionBotActionTimerKey(matchId: string, roundId: string, seatId: string): string {
  return `${matchId}:${roundId}:${seatId}`;
}

export async function scheduleAuctionBotActionTimer(
  state: AuctionMatchState,
  options: AuctionBotTimerOptions = {}
): Promise<void> {
  const round = state.currentRound;
  if (state.phase !== 'bidding' || !round?.currentTurnSeatId || !round.turnEndsAt) return;

  const player = state.seats.find((seat) => seat.seatId === round.currentTurnSeatId);
  if (!player?.isBot) return;

  const context = resolveRealtimeAuctionContext(options);
  const now = context.now();
  const dueAt = getBotActionDueAt(now, new Date(round.turnEndsAt), context.random, player.botProfile);
  const scheduledDueAt = isHarnessFastTimers()
    ? new Date(now.getTime() + harnessDelayMs(Math.max(0, dueAt.getTime() - now.getTime()), 75))
    : dueAt;

  await scheduleRealtimeTimer(
    'auction_bot_action',
    auctionBotActionTimerKey(state.matchId, round.roundId, round.currentTurnSeatId),
    scheduledDueAt,
    {
      kind: 'auction_bot_action',
      matchId: state.matchId,
      roundId: round.roundId,
      expectedTurnSeatId: round.currentTurnSeatId,
      stateVersion: state.version,
      turnEndsAt: round.turnEndsAt,
    }
  );
}

export async function runAuctionBotActionTimer(
  io: QuizballServer,
  payload: AuctionBotActionTimerPayload,
  options: AuctionBotTimerOptions = {}
): Promise<AuctionBotActionOutcome> {
  const outcome = await applyAuctionBotAction(payload, options);

  if (outcome.kind === 'noop') return outcome;

  if (outcome.kind === 'bot_bid') {
    io.to(`match:${outcome.state.matchId}`).emit('auction:bid_accepted', buildBidAcceptedPayload(outcome.state, outcome));
  } else {
    io.to(`match:${outcome.state.matchId}`).emit('auction:fold_accepted', buildFoldAcceptedPayload(outcome.state, outcome));
  }

  await emitPostBotMutationEvents(io, outcome.state, options);
  return outcome;
}

/**
 * Decide one bot turn. PURE: all randomness arrives through `random` (the
 * harness seeds it via AuctionEngineContext), and the bot's personality comes
 * from the seat's own `botProfile`, so the same seed + profile always yields the
 * same decision.
 *
 * A seat with no profile (human-facing ephemeral bot, or the flag-off path) uses
 * EPHEMERAL_AUCTION_BOT_BEHAVIOUR. All behaviours are tuned for the 350M
 * profit×chemistry economy: willingness bands centre BELOW effective value
 * (profit margin) and marginal chemistry is priced into the card.
 */
export function decideAuctionBotAction(
  state: AuctionMatchState,
  seatId: string,
  random: () => number = getRandom
): BotDecision {
  const round = state.currentRound;
  const player = state.seats.find((seat) => seat.seatId === seatId);
  if (state.phase !== 'bidding' || !round || !player?.isBot) return { kind: 'noop', reason: 'not_bot_turn' };
  if (round.currentTurnSeatId !== seatId) return { kind: 'noop', reason: 'turn_mismatch' };
  if (player.isEliminated || !needsPosition(player, round.positionGroup)) return { kind: 'noop', reason: 'bot_cannot_bid' };
  if (round.foldedSeatIds.includes(seatId)) return { kind: 'noop', reason: 'bot_already_folded' };
  if (round.highestBidderSeatId === seatId) return { kind: 'noop', reason: 'bot_is_high_bidder' };

  const behaviour = resolveAuctionBotBehaviour(player.botProfile);
  const emptySlots = getEmptySlots(player.team);
  const minBid = getMinBid(round.startingPrice, round.highestBid);
  const hardMaxBid = getMaxBid(player.budget, emptySlots);
  if (hardMaxBid < minBid) {
    return round.highestBidderSeatId ? { kind: 'fold' } : { kind: 'noop', reason: 'bot_cannot_open' };
  }

  // Budget discipline: a skilled bot commits only part of its per-slot ceiling to
  // one player, holding the rest back for the slots it still has to fill. Never
  // drops below minBid — discipline must not make a bot unable to open a round it
  // can afford (that would silently shrink the field and stall bidding).
  const maxBid = Math.max(minBid, Math.floor(hardMaxBid * behaviour.budgetDiscipline));

  // Bots price the card off what they BELIEVE it is worth, not the hidden
  // trueValue: the perceived value carries a per-seat per-round misjudgement,
  // so a bot can overpay for a lemon or let a star go cheap exactly like a
  // clue-reading human. The estimate is hash-derived (never RNG), so it holds
  // for the whole round on every replica; the margin draw below stays
  // per-turn randomness, as it always was.
  const estimateKey = `${state.matchId}:${round.roundId}:${round.footballer.id}`;
  const perceivedValue = perceivedCardValue({
    trueValue: round.footballer.trueValue,
    profile: player.botProfile,
    seatId,
    estimateKey,
  });

  // A card is worth more TO THIS BOT when it links with the squad: each squad
  // chemistry point multiplies final PROFIT by ~+10%. But the card's
  // club/league/nation are concealed until reveal, so pricing the link every
  // round is another form of peeking — a bot only spots it when its
  // skill-scaled recognition draw says so. When spotted, chemistry raises
  // willingness within the profit region, capped at the PERCEIVED value
  // (under the bot's beliefs, bidding above value is a guaranteed unamplified
  // loss — auction-rules getAdjustedProfit never amplifies losses). The
  // margin band's top can still exceed the perceived value for wild profiles
  // (deliberate human-like overpays, same as before this fix), so a bait is
  // bounded by misjudgement × band top, not by misjudgement alone.
  const chemGain = recognizesChemistryLink({ profile: player.botProfile, seatId, estimateKey })
    ? chemistryGainIfAdded(player.team, round.footballer, round.positionGroup)
    : 0;
  const baseWillingness = Math.floor(
    perceivedValue * (behaviour.willingnessFloor + random() * behaviour.willingnessSpread)
  );
  const chemBoosted = Math.floor(baseWillingness * (1 + 0.1 * chemGain * behaviour.chemWeight));
  const willingness = Math.max(
    baseWillingness,
    Math.min(perceivedValue, chemBoosted)
  );
  if (round.highestBidderSeatId && minBid > willingness) {
    return { kind: 'fold' };
  }

  // Opening keeps a floor at minBid (a bot must still be able to open an
  // affordable round), but jumps are clamped to willingness in both cases —
  // without that, an opener could leap past its own valuation and self-harm
  // with nobody bidding against it.
  const cap = round.highestBidderSeatId
    ? Math.min(maxBid, willingness)
    : Math.min(maxBid, Math.max(minBid, willingness));
  let amount = minBid;
  if (random() >= behaviour.jumpThreshold) {
    amount += MIN_BID_INCREMENT * (1 + Math.floor(random() * 3));
  }
  amount = Math.min(amount, cap);
  if (amount < minBid) {
    return round.highestBidderSeatId ? { kind: 'fold' } : { kind: 'noop', reason: 'bot_bid_below_min' };
  }

  return { kind: 'bid', amount };
}

async function applyAuctionBotAction(
  payload: AuctionBotActionTimerPayload,
  options: AuctionBotTimerOptions
): Promise<AuctionBotActionOutcome> {
  const context = resolveRealtimeAuctionContext(options);
  return auctionStateStore.mutate(payload.matchId, (current) => {
    const validation = validateBotPayload(current, payload);
    if (validation) return skipAuctionMatchMutation(noop(validation));

    const decision = decideAuctionBotAction(current, payload.expectedTurnSeatId, context.random);
    if (decision.kind === 'noop') return skipAuctionMatchMutation(noop(decision.reason));

    const nextState = decision.kind === 'bid'
      ? applyBid(current, payload.expectedTurnSeatId, decision.amount, context)
      : applyFold(current, payload.expectedTurnSeatId, context);

    return saveAuctionMatchMutation(nextState, (saved) => (
      decision.kind === 'bid'
        ? { kind: 'bot_bid', state: saved, seatId: payload.expectedTurnSeatId, amount: decision.amount }
        : { kind: 'bot_fold', state: saved, seatId: payload.expectedTurnSeatId }
    ));
  }, {
    now: context.now,
    onMissingState: () => noop('missing_state'),
  });
}

async function emitPostBotMutationEvents(
  io: QuizballServer,
  state: AuctionMatchState,
  options: AuctionBotTimerOptions
): Promise<void> {
  if (state.phase === 'bidding' && state.currentRound?.currentTurnSeatId) {
    await emitAndScheduleBotTurnStarted(io, state, options);
    return;
  }

  await advanceAuctionMatchFlowAfterMutation(io, state, options);
}

async function emitAndScheduleBotTurnStarted(
  io: QuizballServer,
  state: AuctionMatchState,
  options: AuctionBotTimerOptions
): Promise<void> {
  const payload = buildTurnStartedPayload(state);
  if (!payload) return;

  io.to(`match:${state.matchId}`).emit('auction:turn_started', payload);
  await scheduleAuctionTurnTimeoutTimerForBotService(state);
  await scheduleAuctionBotActionTimer(state, options);
}

async function scheduleAuctionTurnTimeoutTimerForBotService(state: AuctionMatchState): Promise<void> {
  const round = state.currentRound;
  if (state.phase !== 'bidding' || !round?.currentTurnSeatId || !round.turnEndsAt) return;
  const turnEndsAt = new Date(round.turnEndsAt);
  const nowMs = Date.now();
  const dueAt = isHarnessFastTimers()
    ? new Date(nowMs + harnessDelayMs(Math.max(0, turnEndsAt.getTime() - nowMs), 75))
    : turnEndsAt;

  await scheduleRealtimeTimer(
    'auction_turn_timeout',
    `${state.matchId}:${round.roundId}:${round.currentTurnSeatId}`,
    dueAt,
    {
      kind: 'auction_turn_timeout',
      matchId: state.matchId,
      roundId: round.roundId,
      expectedTurnSeatId: round.currentTurnSeatId,
      stateVersion: state.version,
      turnEndsAt: round.turnEndsAt,
    }
  );
}

function validateBotPayload(state: AuctionMatchState, payload: AuctionBotActionTimerPayload): string | null {
  const round = state.currentRound;
  if (state.version !== payload.stateVersion) return 'version_mismatch';
  if (state.phase !== 'bidding') return 'phase_mismatch';
  if (!round) return 'missing_round';
  if (round.roundId !== payload.roundId) return 'round_mismatch';
  if (round.currentTurnSeatId !== payload.expectedTurnSeatId) return 'turn_mismatch';
  if (round.turnEndsAt !== payload.turnEndsAt) return 'turn_deadline_mismatch';
  const player = state.seats.find((seat) => seat.seatId === payload.expectedTurnSeatId);
  if (!player?.isBot) return 'not_bot_turn';
  return null;
}

function getBotActionDueAt(
  now: Date,
  turnEndsAt: Date,
  random: () => number,
  profile?: AuctionBotProfile | null
): Date {
  // Persistent bots deliberate inside their own personality-derived window; a
  // seat with no profile keeps the shared ephemeral band exactly as before.
  const { minThinkMs, maxThinkMs } = profile
    ? resolveAuctionBotBehaviour(profile)
    : { minThinkMs: AUCTION_BOT_MIN_THINK_MS, maxThinkMs: AUCTION_BOT_MAX_THINK_MS };
  const delayMs = minThinkMs + Math.floor(random() * (maxThinkMs - minThinkMs + 1));
  const dueAtMs = Math.min(now.getTime() + delayMs, turnEndsAt.getTime());
  return new Date(dueAtMs);
}

function noop(reason: string): AuctionBotActionOutcome {
  return { kind: 'noop', reason };
}
