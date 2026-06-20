import { randomUUID } from 'crypto';
import { getRandom } from '../../core/rng.js';
import { harnessDelayMs } from '../../core/harness-timing.js';
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
  type PublicAuctionRoundState,
} from '../../modules/auction/auction-match-state.js';
import { auctionStateStore } from '../../modules/auction/auction-state.store.js';
import type { AuctionFootballer, PositionGroup } from '../../modules/auction/auction.types.js';
import { scheduleRealtimeTimer } from '../realtime-timer-scheduler.js';
import type { QuizballServer } from '../socket-server.js';
import type {
  AuctionMatchFinishedPayload,
  AuctionRoundRevealedPayload,
  AuctionSoloPickSelectedPayload,
  AuctionSoloPickStartedPayload,
  AuctionSquadUpdatedPayload,
} from '../socket.types.js';

export interface AuctionMatchFlowOptions {
  now?: Date;
  context?: AuctionEngineContext;
}

export class AuctionSoloPickActionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly meta?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
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
  }

  const advanced = await advanceToNextAuctionStep(state, options);
  return emitAuctionStepStarted(io, advanced, options);
}

export async function handleAuctionSoloPickSelection(
  io: QuizballServer,
  state: AuctionMatchState,
  seatId: string,
  option: 'A' | 'B',
  options: AuctionMatchFlowOptions = {}
): Promise<AuctionMatchState> {
  const context = resolveFlowContext(options);
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
  const context = resolveFlowContext(options);
  const saved = await auctionStateStore.withLock(matchId, async () => {
    const current = await auctionStateStore.load(matchId);
    if (!current) {
      throw new AuctionSoloPickActionError('auction_match_not_found', 'Auction match not found');
    }
    if (current.phase !== 'solo_pick' || !current.soloPick) {
      throw new AuctionSoloPickActionError('auction_no_active_solo_pick', 'No active auction solo pick');
    }
    const seat = findAuctionSeatByUserId(current, userId);
    if (!seat) {
      throw new AuctionSoloPickActionError('auction_user_not_in_match', 'User is not seated in this auction match');
    }
    if (current.soloPick.playerSeatId !== seat.seatId) {
      throw new AuctionSoloPickActionError('auction_solo_pick_not_yours', 'Solo pick belongs to another seat');
    }

    const selected = selectSoloPickOption(current, seat.seatId, option, context);
    return auctionStateStore.save({
      ...selected,
      version: current.version + 1,
    }, {
      expectedVersion: current.version,
      now: context.now(),
    });
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
    });
    await scheduleAuctionClueRevealTimerFromFlow(state, options);
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
      return handleAuctionSoloPickSelection(io, state, soloSeat.seatId, 'B', options);
    }
    return state;
  }

  if (state.phase === 'finished' && state.rankings) {
    emitMatchFinished(io, state);
    await auctionStateStore.clearIndexes(state);
  }
  return state;
}

async function advanceToNextAuctionStep(
  state: AuctionMatchState,
  options: AuctionMatchFlowOptions
): Promise<AuctionMatchState> {
  const context = resolveFlowContext(options);
  const nextBase = closeResolvedRound(state);
  const nextState = await createNextStepState(nextBase, context);

  if (nextState === state) return state;
  if (nextState.version !== state.version) return nextState;

  return auctionStateStore.withLock(state.matchId, async () => {
    const current = await auctionStateStore.load(state.matchId);
    if (!current || current.version !== state.version) return nextState;

    const saved = await auctionStateStore.save({
      ...nextState,
      version: current.version + 1,
    }, {
      expectedVersion: current.version,
      now: context.now(),
    });
    return saved;
  });
}

async function createNextStepState(
  state: AuctionMatchState,
  context: Required<Pick<AuctionEngineContext, 'now' | 'random' | 'createId'>>
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

function emitMatchFinished(io: QuizballServer, state: AuctionMatchState): void {
  if (!state.rankings) return;
  const publicState = toPublicAuctionMatchState(state);
  io.to(`match:${state.matchId}`).emit('auction:match_finished', {
    matchId: state.matchId,
    rankings: state.rankings,
    winnerSeatId: state.rankings[0]?.seatId ?? null,
    state: publicState,
    stateVersion: state.version,
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

function requirePublicRound(publicState: PublicAuctionMatchState): PublicAuctionRoundState {
  if (!publicState.currentRound) {
    throw new Error('Auction round unavailable');
  }
  return publicState.currentRound;
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

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [out[index], out[swapIndex]] = [out[swapIndex], out[index]];
  }
  return out;
}

function resolveFlowContext(
  options: AuctionMatchFlowOptions
): Required<Pick<AuctionEngineContext, 'now' | 'random' | 'createId'>> {
  return {
    now: options.context?.now ?? (() => options.now ?? new Date()),
    random: options.context?.random ?? getRandom,
    createId: options.context?.createId ?? (() => randomUUID()),
  };
}
