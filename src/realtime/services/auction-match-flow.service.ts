import { harnessDelayMs } from '../../core/harness-timing.js';
import { logger } from '../../core/logger.js';
import { shuffle } from '../../core/rng.js';
import {
  resolveAuctionContext,
  type ResolvedAuctionEngineContext,
} from '../../modules/auction/auction-context.js';
import {
  auctionContentService,
  AuctionContentUnavailableError,
  type AuctionContentLocale,
} from '../../modules/auction/index.js';
import {
  finishMatch,
  selectSoloPickOption,
  startBiddingRound,
  startSoloPick,
  type AuctionEngineContext,
} from '../../modules/auction/auction-engine.js';
import {
  CLUE_REVEAL_INTERVAL_MS,
  POSITION_GROUPS,
} from '../../modules/auction/auction.constants.js';
import {
  canPlayerContinue,
  needsPosition,
} from '../../modules/auction/auction-rules.js';
import {
  findAuctionSeatByUserId,
  toPublicAuctionMatchState,
  type AuctionMatchState,
  type PublicAuctionMatchState,
} from '../../modules/auction/auction-match-state.js';
import {
  auctionStateStore,
  saveAuctionMatchMutation,
  skipAuctionMatchMutation,
} from '../../modules/auction/auction-state.store.js';
import type { AuctionFootballer, PositionGroup } from '../../modules/auction/auction.types.js';
import { persistFinishedAuctionMatch } from './auction-persistence.service.js';
import { getAuctionPause } from './auction-disconnect-state.service.js';
import { scheduleRealtimeTimer, type RealtimeTimerPayload } from '../realtime-timer-scheduler.js';
import type { QuizballServer } from '../socket-server.js';
import type {
  AuctionMatchFinishedPayload,
  AuctionRoundRevealedPayload,
  AuctionSoloPickSelectedPayload,
  AuctionSoloPickStartedPayload,
  AuctionSquadUpdatedPayload,
} from '../socket.types.js';
import { AuctionActionError } from './auction-action-errors.js';
import { requirePublicRound } from './auction-realtime-payloads.js';
import { openAuctionUiReadyGate } from './auction-ui-ready.service.js';

const AUCTION_REVEAL_UI_READY_CEILING_MS = 6_000;
// A human's solo pick auto-resolves after this long (bots pick instantly).
// Without a deadline a frozen tab / silent drop froze the whole match forever.
const AUCTION_SOLO_PICK_TIMEOUT_MS = 30_000;
// Auto-selection on timeout matches the bot default.
const AUCTION_SOLO_PICK_DEFAULT_OPTION = 'B' as const;

export type AuctionSoloPickTimeoutTimerPayload = Extract<RealtimeTimerPayload, { kind: 'auction_solo_pick_timeout' }>;

export interface AuctionMatchFlowOptions {
  now?: Date;
  context?: AuctionEngineContext;
}

/**
 * Durable deadline for a HUMAN solo pick (keyed by matchId — one solo pick at a
 * time). `startedAt` scopes the timer to this exact pick so a stale timer for a
 * previous pick no-ops.
 */
export async function scheduleAuctionSoloPickTimeoutTimer(
  state: AuctionMatchState,
  scheduleOptions: { fromNow?: boolean } = {}
): Promise<void> {
  const soloPick = state.soloPick;
  if (state.phase !== 'solo_pick' || !soloPick || soloPick.selectedOption) return;
  const seat = state.seats.find((entry) => entry.seatId === soloPick.playerSeatId);
  if (!seat || seat.isBot) return;

  const startedAtMs = Date.parse(soloPick.startedAt);
  // `fromNow` re-bases the deadline after a pause/resume — the original
  // startedAt-based deadline may already be in the past.
  const baseMs = scheduleOptions.fromNow || !Number.isFinite(startedAtMs) ? Date.now() : startedAtMs;
  const dueAt = baseMs + harnessDelayMs(AUCTION_SOLO_PICK_TIMEOUT_MS, 1_000);
  await scheduleRealtimeTimer(
    'auction_solo_pick_timeout',
    state.matchId,
    new Date(dueAt),
    {
      kind: 'auction_solo_pick_timeout',
      matchId: state.matchId,
      seatId: soloPick.playerSeatId,
      startedAt: soloPick.startedAt,
    },
  );
}

/**
 * Solo-pick deadline elapsed → auto-select the default option (same as the bot
 * default) so the match can never freeze on an absent human. Idempotent: no-ops
 * if the pick already resolved or a different pick is live.
 */
export async function runAuctionSoloPickTimeoutTimer(
  io: QuizballServer,
  payload: AuctionSoloPickTimeoutTimerPayload,
  options: AuctionMatchFlowOptions = {}
): Promise<void> {
  const state = await auctionStateStore.load(payload.matchId).catch(() => null);
  if (!state || state.phase !== 'solo_pick' || !state.soloPick) return;
  if (state.soloPick.playerSeatId !== payload.seatId) return;
  if (state.soloPick.startedAt !== payload.startedAt) return;
  if (state.soloPick.selectedOption) return;

  // Player is in their disconnect grace window: NEVER auto-select for them —
  // the grace forfeit owns the outcome. Defer past the grace instant; if they
  // resumed, resume re-arms a fresh deadline and this stale copy no-ops.
  const pause = await getAuctionPause(payload.matchId);
  if (pause?.seatId === payload.seatId) {
    const pauseUntilMs = Date.parse(pause.pauseUntil);
    const dueAt = new Date(Math.max(Number.isFinite(pauseUntilMs) ? pauseUntilMs : 0, Date.now()) + 2_000);
    await scheduleRealtimeTimer('auction_solo_pick_timeout', payload.matchId, dueAt, payload);
    logger.debug({ matchId: payload.matchId, seatId: payload.seatId }, 'Auction solo-pick timeout deferred (player paused)');
    return;
  }

  logger.info(
    { matchId: payload.matchId, seatId: payload.seatId },
    'Auction solo pick timed out; auto-selecting default option'
  );
  try {
    await handleAuctionSoloPickSelection(io, state, payload.seatId, AUCTION_SOLO_PICK_DEFAULT_OPTION, options);
  } catch (error) {
    // A racing manual selection can make this throw — that's fine, the pick
    // resolved either way.
    logger.warn({ error, matchId: payload.matchId }, 'Auction solo-pick timeout auto-select failed');
  }
}

export async function advanceAuctionMatchFlowAfterMutation(
  io: QuizballServer,
  state: AuctionMatchState,
  options: AuctionMatchFlowOptions = {}
): Promise<AuctionMatchState> {
  if (state.phase === 'bidding') return state;

  if (state.phase === 'reveal' && state.currentRound) {
    emitRoundRevealed(io, state);
    openAuctionUiReadyGate({
      io,
      state,
      phase: 'reveal',
      ceilingMs: AUCTION_REVEAL_UI_READY_CEILING_MS,
      dispatch: () => {
        // Never let a transient failure (e.g. a brief Redis blip) become an
        // unhandled rejection — that would leave the match frozen at reveal.
        // Log it; the boot/reconnect re-arm (ensureAuctionActiveTimers) re-opens
        // the gate and advances if this dispatch was lost.
        advanceAuctionMatchFlowFromRevealGate(io, state, options).catch((error) => {
          logger.warn(
            { error, matchId: state.matchId, phase: 'reveal' },
            'Auction reveal-gate advance failed; will recover via re-arm'
          );
        });
      },
    });
    return state;
  }

  const advanced = await advanceToNextAuctionStep(state, options);
  return emitAuctionStepStarted(io, advanced, options);
}

async function advanceAuctionMatchFlowFromRevealGate(
  io: QuizballServer,
  state: AuctionMatchState,
  options: AuctionMatchFlowOptions
): Promise<void> {
  const advanced = await advanceToNextAuctionStep(state, options);
  await emitAuctionStepStarted(io, advanced, options);
}

export async function handleAuctionSoloPickSelection(
  io: QuizballServer,
  state: AuctionMatchState,
  seatId: string,
  option: 'A' | 'B',
  options: AuctionMatchFlowOptions = {}
): Promise<AuctionMatchState> {
  const context = resolveAuctionContext(options);
  const selected = selectSoloPickOption(state, seatId, option, context);
  const saved = await auctionStateStore.save({
    ...selected,
    version: state.version + 1,
  }, {
    expectedVersion: state.version,
    now: context.now(),
  });

  emitSoloPickSelected(io, saved, seatId, option);
  const advanced = await advanceAuctionMatchFlowAfterMutation(io, saved, options);
  return advanced;
}

export async function handleAuctionSoloPickSelectionForUser(
  io: QuizballServer,
  matchId: string,
  userId: string,
  option: 'A' | 'B',
  options: AuctionMatchFlowOptions = {}
): Promise<AuctionMatchState> {
  const context = resolveAuctionContext(options);
  const saved = await auctionStateStore.mutate(matchId, (current) => {
    if (current.phase !== 'solo_pick' || !current.soloPick) {
      throw new AuctionActionError('auction_no_active_solo_pick', 'No active auction solo pick');
    }
    const seat = findAuctionSeatByUserId(current, userId);
    if (!seat) {
      throw new AuctionActionError('auction_user_not_in_match', 'User is not seated in this auction match');
    }
    if (current.soloPick.playerSeatId !== seat.seatId) {
      throw new AuctionActionError('auction_solo_pick_not_yours', 'Solo pick belongs to another seat');
    }

    const selected = selectSoloPickOption(current, seat.seatId, option, context);
    return saveAuctionMatchMutation(selected, (savedState) => savedState);
  }, {
    now: context.now,
    onMissingState: () => {
      throw new AuctionActionError('auction_match_not_found', 'Auction match not found');
    },
  });

  emitSoloPickSelected(io, saved, saved.soloPick?.playerSeatId ?? '', option);
  return advanceAuctionMatchFlowAfterMutation(io, saved, options);
}

export async function emitAuctionStepStarted(
  io: QuizballServer,
  state: AuctionMatchState,
  options: AuctionMatchFlowOptions = {}
): Promise<AuctionMatchState> {
  if (state.phase === 'clue_reveal' && state.currentRound) {
    const publicState = toPublicAuctionMatchState(state);
    io.to(`match:${state.matchId}`).emit('auction:round_started', {
      matchId: state.matchId,
      round: requirePublicRound(publicState),
      stateVersion: state.version,
      serverNow: new Date().toISOString(),
    });
    openAuctionUiReadyGate({
      io,
      state,
      phase: 'round',
      dispatch: () => {
        void scheduleAuctionClueRevealTimerFromFlow(state, options);
      },
    });
    return state;
  }

  if (state.phase === 'solo_pick' && state.soloPick) {
    const publicState = toPublicAuctionMatchState(state);
    if (!publicState.soloPick) return state;
    io.to(`match:${state.matchId}`).emit('auction:solo_pick_started', {
      matchId: state.matchId,
      soloPick: publicState.soloPick,
      stateVersion: state.version,
    } satisfies AuctionSoloPickStartedPayload);

    const soloSeat = state.seats.find((seat) => seat.seatId === state.soloPick?.playerSeatId);
    if (soloSeat?.isBot) {
      return handleAuctionSoloPickSelection(io, state, soloSeat.seatId, AUCTION_SOLO_PICK_DEFAULT_OPTION, options);
    }
    // Human pick: arm the durable deadline so an absent player can't freeze
    // the match — auto-resolves to the default option on expiry.
    await scheduleAuctionSoloPickTimeoutTimer(state);
    return state;
  }

  if (state.phase === 'finished' && state.rankings) {
    // Persist first so we know each human's coin reward, then emit it with the
    // finish payload. Persistence is best-effort (its own try/catch) and returns
    // {} on failure, so a DB hiccup just means no reward shown — never blocks the
    // finish broadcast.
    const coinsByUserId = await persistFinishedAuctionMatch(state);
    emitMatchFinished(io, state, coinsByUserId);
    await auctionStateStore.clearIndexes(state);
  }
  return state;
}

async function advanceToNextAuctionStep(
  state: AuctionMatchState,
  options: AuctionMatchFlowOptions
): Promise<AuctionMatchState> {
  const context = resolveAuctionContext(options);
  const nextBase = closeResolvedRound(state);
  const nextState = await createNextStepState(nextBase, context);

  if (nextState === state) return state;
  if (nextState.version !== state.version) return nextState;

  return auctionStateStore.mutate(state.matchId, (current) => {
    if (current.version !== state.version) {
      return skipAuctionMatchMutation(nextState);
    }

    return saveAuctionMatchMutation(nextState, (saved) => saved);
  }, {
    now: context.now,
    onMissingState: () => nextState,
  });
}

async function createNextStepState(
  state: AuctionMatchState,
  context: ResolvedAuctionEngineContext
): Promise<AuctionMatchState> {
  if (state.phase === 'finished' || state.phase === 'clue_reveal' || state.phase === 'solo_pick') {
    return state;
  }

  const activePlayers = state.seats.filter(canPlayerContinue);
  if (activePlayers.length === 0) {
    return finishMatch(state, context);
  }

  const positions = shuffle(
    POSITION_GROUPS.filter((position) => activePlayers.some((player) => needsPosition(player, position))),
    context.random
  );
  const locale = resolveLocale(state);

  for (const position of positions) {
    const needers = activePlayers.filter((player) => needsPosition(player, position));
    const optionA = await getNextPublishedCard(locale, position, state.usedClueCardIds);
    if (!optionA) continue;

    if (needers.length === 1) {
      const optionBExcludeIds = optionA.clueCardId
        ? [...state.usedClueCardIds, optionA.clueCardId]
        : state.usedClueCardIds;
      const optionB = await getNextPublishedCard(locale, position, optionBExcludeIds);
      return startSoloPick(state, needers[0].seatId, position, optionA, optionB ?? optionA, context);
    }

    return startBiddingRound(state, position, optionA, needers, context);
  }

  return finishMatch(state, context);
}

async function getNextPublishedCard(
  locale: AuctionContentLocale,
  positionGroup: PositionGroup,
  excludeClueCardIds: readonly string[]
): Promise<AuctionFootballer | null> {
  try {
    return await auctionContentService.getRandomPublishedAuctionCard({
      locale,
      positionGroup,
      excludeClueCardIds: [...excludeClueCardIds],
    });
  } catch (error) {
    if (error instanceof AuctionContentUnavailableError) return null;
    throw error;
  }
}

function closeResolvedRound(state: AuctionMatchState): AuctionMatchState {
  if (state.phase !== 'reveal' || !state.currentRound) return state;
  return {
    ...state,
    phase: 'created',
    completedRounds: [...state.completedRounds, state.currentRound],
    currentRound: null,
  };
}

function emitRoundRevealed(io: QuizballServer, state: AuctionMatchState): void {
  const publicState = toPublicAuctionMatchState(state);
  io.to(`match:${state.matchId}`).emit('auction:round_revealed', buildRoundRevealedPayload(publicState));
  if (!state.currentRound?.winnerSeatId) return;

  const player = publicState.seats.find((seat) => seat.seatId === state.currentRound?.winnerSeatId);
  if (!player) return;
  io.to(`match:${state.matchId}`).emit('auction:squad_updated', {
    matchId: state.matchId,
    seatId: player.seatId,
    player,
    stateVersion: state.version,
  } satisfies AuctionSquadUpdatedPayload);
}

function emitSoloPickSelected(
  io: QuizballServer,
  state: AuctionMatchState,
  seatId: string,
  option: 'A' | 'B'
): void {
  const publicState = toPublicAuctionMatchState(state);
  const player = publicState.seats.find((seat) => seat.seatId === seatId);
  if (!player) return;
  io.to(`match:${state.matchId}`).emit('auction:solo_pick_selected', {
    matchId: state.matchId,
    seatId,
    option,
    player,
    stateVersion: state.version,
  } satisfies AuctionSoloPickSelectedPayload);
  io.to(`match:${state.matchId}`).emit('auction:squad_updated', {
    matchId: state.matchId,
    seatId,
    player,
    stateVersion: state.version,
  } satisfies AuctionSquadUpdatedPayload);
}

function emitMatchFinished(
  io: QuizballServer,
  state: AuctionMatchState,
  coinsByUserId: Record<string, number> = {},
): void {
  if (!state.rankings) return;
  const publicState = toPublicAuctionMatchState(state);
  io.to(`match:${state.matchId}`).emit('auction:match_finished', {
    matchId: state.matchId,
    rankings: state.rankings,
    winnerSeatId: state.rankings[0]?.seatId ?? null,
    state: publicState,
    stateVersion: state.version,
    coinsByUserId,
  } satisfies AuctionMatchFinishedPayload);
}

function buildRoundRevealedPayload(publicState: PublicAuctionMatchState): AuctionRoundRevealedPayload {
  const round = requirePublicRound(publicState);
  return {
    matchId: publicState.matchId,
    roundId: round.roundId,
    winnerSeatId: round.winnerSeatId,
    winningBid: round.winningBid,
    round,
    stateVersion: publicState.version,
  };
}

function resolveLocale(state: AuctionMatchState): AuctionContentLocale {
  return state.locale ?? 'en';
}

async function scheduleAuctionClueRevealTimerFromFlow(
  state: AuctionMatchState,
  options: AuctionMatchFlowOptions
): Promise<void> {
  const round = state.currentRound;
  if (state.phase !== 'clue_reveal' || !round) return;

  const expectedClueIndex = round.clueRevealIndex + 1;
  const clueCount = round.footballer.clues?.length ?? 0;
  if (expectedClueIndex > clueCount) return;

  const nowMs = (options.now ?? options.context?.now?.() ?? new Date()).getTime();
  const dueAt = new Date(nowMs + harnessDelayMs(CLUE_REVEAL_INTERVAL_MS, 50));

  await scheduleRealtimeTimer(
    'auction_clue_reveal',
    `${state.matchId}:${round.roundId}:${expectedClueIndex}`,
    dueAt,
    {
      kind: 'auction_clue_reveal',
      matchId: state.matchId,
      roundId: round.roundId,
      expectedClueIndex,
      stateVersion: state.version,
    }
  );
}
