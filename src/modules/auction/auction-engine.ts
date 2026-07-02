import { shuffle } from '../../core/rng.js';
import {
  AUCTION_SEAT_COUNT,
  FORMATIONS,
  OPENING_TURN_MS,
  POSITION_GROUPS,
  RAISE_TURN_MS,
  STARTING_BUDGET,
} from './auction.constants.js';
import {
  canPlayerContinue,
  createEmptyTeam,
  getEmptySlots,
  getMaxBid,
  isBidValid,
  needsPosition,
  rankAuctionPlayers,
  shouldEliminateAfterPurchase,
} from './auction-rules.js';
import type {
  AuctionFootballer,
  AuctionPlayer,
  FormationName,
  PositionGroup,
} from './auction.types.js';
import type {
  AuctionMatchState,
  AuctionRoundState,
  AuctionSoloPickOptionState,
} from './auction-match-state.js';
import {
  resolveAuctionContext,
  type AuctionEngineContext,
  type ResolvedAuctionEngineContext,
} from './auction-context.js';

export type { AuctionEngineContext } from './auction-context.js';

export type AuctionCardPool = Partial<Record<PositionGroup, readonly AuctionFootballer[]>>;

export interface CreateInitialAuctionMatchInput {
  matchId?: string;
  humanUserId: string;
  humanDisplayName: string;
  humanPlayers?: readonly { userId: string; displayName: string; avatarCustomization?: unknown | null }[];
  // AI bidder profiles (name + avatar) for the seats not filled by humans.
  // Picked by the realtime layer from the shared AI pool so bots look like
  // real people; falls back to `Bot N` when not supplied (e.g. pure-engine tests).
  bots?: readonly { displayName: string; avatarUrl?: string | null }[];
  formation?: FormationName;
  locale?: 'en' | 'ka';
  context?: AuctionEngineContext;
}

export class AuctionEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class AuctionInvalidActionError extends AuctionEngineError {}

export function createInitialAuctionMatch(input: CreateInitialAuctionMatchInput): AuctionMatchState {
  const context = resolveAuctionContext(input.context);
  const now = context.nowIso();
  const formation = input.formation ?? pickOne(FORMATIONS, context.random).name;
  const humanPlayers = input.humanPlayers && input.humanPlayers.length > 0
    ? [...input.humanPlayers]
    : [{ userId: input.humanUserId, displayName: input.humanDisplayName }];
  if (humanPlayers.length > AUCTION_SEAT_COUNT) {
    throw new AuctionEngineError('Auction match cannot exceed seat count');
  }
  const seats: AuctionPlayer[] = [
    ...humanPlayers.map((player, index) => ({
      seatId: humanPlayers.length === 1 ? 'seat-human' : `seat-human-${index + 1}`,
      userId: player.userId,
      displayName: player.displayName,
      avatarCustomization: player.avatarCustomization ?? null,
      isBot: false,
      budget: STARTING_BUDGET,
      team: createEmptyTeam(formation),
      isEliminated: false,
    })),
    ...Array.from({ length: AUCTION_SEAT_COUNT - humanPlayers.length }, (_, index) => ({
      seatId: context.createId('bot-seat') || `seat-bot-${index + 1}`,
      userId: null,
      displayName: input.bots?.[index]?.displayName ?? `Bot ${index + 1}`,
      avatarUrl: input.bots?.[index]?.avatarUrl ?? null,
      isBot: true,
      budget: STARTING_BUDGET,
      team: createEmptyTeam(formation),
      isEliminated: false,
    })),
  ];

  return {
    matchId: input.matchId ?? context.createId('match'),
    version: 0,
    locale: input.locale ?? 'en',
    phase: 'created',
    formation,
    seats,
    currentRound: null,
    completedRounds: [],
    soloPick: null,
    usedClueCardIds: [],
    rankings: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function pickNextPosition(
  state: AuctionMatchState,
  cards: AuctionCardPool,
  contextInput?: AuctionEngineContext
): PositionGroup | null {
  const context = resolveAuctionContext(contextInput);
  const activePlayers = state.seats.filter(canPlayerContinue);
  const candidates = POSITION_GROUPS.filter((position) => (
    activePlayers.some((player) => needsPosition(player, position))
    && getAvailableFootballers(cards, position, state.usedClueCardIds).length > 0
  ));

  if (candidates.length === 0) return null;
  return pickOne(candidates, context.random);
}

export function startBiddingRound(
  state: AuctionMatchState,
  positionGroup: PositionGroup,
  footballer: AuctionFootballer,
  needers: readonly AuctionPlayer[],
  contextInput?: AuctionEngineContext
): AuctionMatchState {
  const context = resolveAuctionContext(contextInput);
  const now = context.nowIso();
  const turnOrder = shuffle(needers.map((player) => player.seatId), context.random);
  const round: AuctionRoundState = {
    roundId: context.createId('round'),
    roundIndex: state.completedRounds.length + 1,
    positionGroup,
    footballer,
    clueRevealIndex: 0,
    bids: [],
    highestBidderSeatId: null,
    highestBid: 0,
    startingPrice: footballer.startingPrice,
    winnerSeatId: null,
    winningBid: 0,
    revealed: false,
    turnOrder,
    currentTurnSeatId: null,
    foldedSeatIds: [],
    turnEndsAt: null,
    startedAt: now,
    updatedAt: now,
  };

  return touch({
    ...state,
    phase: 'clue_reveal',
    currentRound: round,
    soloPick: null,
    usedClueCardIds: appendUsedClueCardId(state.usedClueCardIds, footballer),
  }, context);
}

export function startSoloPick(
  state: AuctionMatchState,
  playerSeatId: string,
  positionGroup: PositionGroup,
  optionA: AuctionFootballer,
  optionB: AuctionFootballer,
  contextInput?: AuctionEngineContext
): AuctionMatchState {
  const context = resolveAuctionContext(contextInput);
  const now = context.nowIso();

  return touch({
    ...state,
    phase: 'solo_pick',
    currentRound: null,
    soloPick: {
      playerSeatId,
      positionGroup,
      optionA: { type: 'revealed', footballer: optionA },
      optionB: {
        type: 'mystery',
        footballer: optionB,
        clues: optionB.clues ? [...optionB.clues] : [],
      },
      selectedOption: null,
      startedAt: now,
    },
    usedClueCardIds: appendUsedClueCardId(
      appendUsedClueCardId(state.usedClueCardIds, optionA),
      optionB
    ),
  }, context);
}

export function selectSoloPickOption(
  state: AuctionMatchState,
  playerSeatId: string,
  option: 'A' | 'B',
  contextInput?: AuctionEngineContext
): AuctionMatchState {
  const context = resolveAuctionContext(contextInput);
  if (state.phase !== 'solo_pick' || !state.soloPick) {
    throw new AuctionInvalidActionError('No active solo pick');
  }
  if (state.soloPick.playerSeatId !== playerSeatId) {
    throw new AuctionInvalidActionError('Solo pick belongs to another seat');
  }

  const selected = option === 'A' ? state.soloPick.optionA : state.soloPick.optionB;
  const players = assignFootballerToSquad(
    state.seats,
    playerSeatId,
    selected.footballer,
    0,
    state.soloPick.positionGroup
  );
  const completedRound = createCompletedSoloPickRound(state, selected, context);

  return touch({
    ...state,
    phase: 'created',
    seats: players,
    currentRound: null,
    completedRounds: [...state.completedRounds, completedRound],
    soloPick: {
      ...state.soloPick,
      selectedOption: option,
    },
  }, context);
}

export function revealNextClue(
  state: AuctionMatchState,
  contextInput?: AuctionEngineContext
): AuctionMatchState {
  const context = resolveAuctionContext(contextInput);
  const round = requireCurrentRound(state);
  if (state.phase !== 'clue_reveal') {
    throw new AuctionInvalidActionError('Cannot reveal clue outside clue reveal phase');
  }

  const clueCount = round.footballer.clues?.length ?? 0;
  if (round.clueRevealIndex >= clueCount) return state;

  return touch({
    ...state,
    currentRound: {
      ...round,
      clueRevealIndex: round.clueRevealIndex + 1,
      updatedAt: context.nowIso(),
    },
  }, context);
}

export function startBidding(
  state: AuctionMatchState,
  contextInput?: AuctionEngineContext
): AuctionMatchState {
  const context = resolveAuctionContext(contextInput);
  const round = requireCurrentRound(state);
  if (state.phase !== 'clue_reveal') {
    throw new AuctionInvalidActionError('Cannot start bidding outside clue reveal phase');
  }
  const clueCount = round.footballer.clues?.length ?? 0;
  if (round.clueRevealIndex < clueCount) {
    throw new AuctionInvalidActionError('All clues must be revealed before bidding starts');
  }

  const firstTurn = getNextBidderSeatId(
    { ...round, currentTurnSeatId: round.turnOrder.at(-1) ?? null },
    state.seats
  );

  if (!firstTurn) {
    return resolveUnsoldRound(state, context);
  }

  return touch({
    ...state,
    phase: 'bidding',
    currentRound: {
      ...round,
      currentTurnSeatId: firstTurn,
      turnEndsAt: addMs(context.now(), getTurnMs(round)),
      updatedAt: context.nowIso(),
    },
  }, context);
}

export function applyBid(
  state: AuctionMatchState,
  seatId: string,
  amount: number,
  contextInput?: AuctionEngineContext
): AuctionMatchState {
  const context = resolveAuctionContext(contextInput);
  const round = requireBiddingRound(state);
  const player = requireCurrentTurnPlayer(state, seatId);

  if (round.highestBidderSeatId === seatId) {
    throw new AuctionInvalidActionError('Current high bidder cannot bid against themselves');
  }

  const emptySlots = getEmptySlots(player.team);
  if (!isBidValid({
    amount,
    budget: player.budget,
    emptySlots,
    startingPrice: round.startingPrice,
    highestBid: round.highestBid,
  })) {
    throw new AuctionInvalidActionError('Invalid auction bid');
  }

  const nextRound = {
    ...round,
    bids: [...round.bids, { seatId, amount, placedAt: context.nowIso() }],
    highestBidderSeatId: seatId,
    highestBid: amount,
    updatedAt: context.nowIso(),
  };

  return advanceTurnOrResolveRound({ ...state, currentRound: nextRound }, context);
}

export function applyFold(
  state: AuctionMatchState,
  seatId: string,
  contextInput?: AuctionEngineContext
): AuctionMatchState {
  const context = resolveAuctionContext(contextInput);
  const round = requireBiddingRound(state);
  requireCurrentTurnPlayer(state, seatId);

  if (!round.highestBidderSeatId) {
    throw new AuctionInvalidActionError('Opening bidder cannot fold');
  }

  const nextRound = {
    ...round,
    foldedSeatIds: unique([...round.foldedSeatIds, seatId]),
    updatedAt: context.nowIso(),
  };

  return advanceTurnOrResolveRound({ ...state, currentRound: nextRound }, context);
}

export function applyTurnTimeout(
  state: AuctionMatchState,
  contextInput?: AuctionEngineContext
): AuctionMatchState {
  const context = resolveAuctionContext(contextInput);
  const round = requireBiddingRound(state);
  const seatId = round.currentTurnSeatId;
  if (!seatId) throw new AuctionInvalidActionError('No active turn');

  if (!round.highestBidderSeatId) {
    return applyBid(state, seatId, round.startingPrice, contextInput);
  }

  const nextRound = {
    ...round,
    foldedSeatIds: unique([...round.foldedSeatIds, seatId]),
    updatedAt: context.nowIso(),
  };
  return advanceTurnOrResolveRound({ ...state, currentRound: nextRound }, context);
}

export function advanceTurnOrResolveRound(
  state: AuctionMatchState,
  contextInput?: AuctionEngineContext
): AuctionMatchState {
  const context = resolveAuctionContext(contextInput);
  const round = requireBiddingRound(state);
  const remaining = getRemainingBidders(round, state.seats);

  if (round.highestBidderSeatId && remaining.length <= 1) {
    return resolveRoundWin(state, context);
  }

  const nextSeatId = getNextBidderSeatId(round, state.seats);
  if (!nextSeatId) {
    return round.highestBidderSeatId
      ? resolveRoundWin(state, context)
      : resolveUnsoldRound(state, context);
  }

  return touch({
    ...state,
    currentRound: {
      ...round,
      currentTurnSeatId: nextSeatId,
      turnEndsAt: addMs(context.now(), getTurnMs(round)),
      updatedAt: context.nowIso(),
    },
  }, context);
}

export function resolveRoundWin(
  state: AuctionMatchState,
  contextInput?: AuctionEngineContext
): AuctionMatchState {
  const context = resolveAuctionContext(contextInput);
  const round = requireCurrentRound(state);
  if (!round.highestBidderSeatId) {
    throw new AuctionInvalidActionError('Cannot resolve round win without a bidder');
  }

  const seats = assignFootballerToSquad(
    state.seats,
    round.highestBidderSeatId,
    round.footballer,
    round.highestBid,
    round.positionGroup
  );

  return touch({
    ...state,
    phase: 'reveal',
    seats,
    currentRound: {
      ...round,
      currentTurnSeatId: null,
      turnEndsAt: null,
      winnerSeatId: round.highestBidderSeatId,
      winningBid: round.highestBid,
      revealed: true,
      clueRevealIndex: round.footballer.clues?.length ?? round.clueRevealIndex,
      updatedAt: context.nowIso(),
    },
  }, context);
}

export function resolveUnsoldRound(
  state: AuctionMatchState,
  contextInput?: AuctionEngineContext
): AuctionMatchState {
  const context = resolveAuctionContext(contextInput);
  const round = requireCurrentRound(state);
  const completedRound = {
    ...round,
    currentTurnSeatId: null,
    turnEndsAt: null,
    winnerSeatId: null,
    winningBid: 0,
    revealed: true,
    clueRevealIndex: round.footballer.clues?.length ?? round.clueRevealIndex,
    updatedAt: context.nowIso(),
  };

  return touch({
    ...state,
    phase: 'created',
    currentRound: null,
    completedRounds: [...state.completedRounds, completedRound],
  }, context);
}

export function assignFootballerToSquad(
  players: readonly AuctionPlayer[],
  seatId: string,
  footballer: AuctionFootballer,
  price: number,
  positionGroup: PositionGroup = footballer.positionGroup
): AuctionPlayer[] {
  return players.map((player) => {
    if (player.seatId !== seatId) return player;

    const budget = player.budget - price;
    const slots = {
      ...player.team.slots,
      [positionGroup]: [...player.team.slots[positionGroup], footballer],
    };
    const team = { ...player.team, slots };
    const emptySlots = getEmptySlots(team);

    return {
      ...player,
      budget,
      team,
      isEliminated: shouldEliminateAfterPurchase(budget, emptySlots),
    };
  });
}

export function advanceToNextRoundOrFinish(
  state: AuctionMatchState,
  cards: AuctionCardPool,
  contextInput?: AuctionEngineContext
): AuctionMatchState {
  const context = resolveAuctionContext(contextInput);
  let nextState = state;

  if (nextState.phase === 'reveal' && nextState.currentRound) {
    nextState = {
      ...nextState,
      phase: 'created',
      completedRounds: [...nextState.completedRounds, nextState.currentRound],
      currentRound: null,
    };
  }

  if (nextState.seats.every((player) => !canPlayerContinue(player))) {
    return finishMatch(nextState, context);
  }

  const position = pickNextPosition(nextState, cards, context);
  if (!position) {
    return finishMatch(nextState, context);
  }

  const needers = nextState.seats.filter((player) => canPlayerContinue(player) && needsPosition(player, position));
  const available = getAvailableFootballers(cards, position, nextState.usedClueCardIds);
  const [optionA, optionB] = available;

  if (!optionA) {
    return finishMatch(nextState, context);
  }

  if (needers.length === 1) {
    return startSoloPick(nextState, needers[0].seatId, position, optionA, optionB ?? optionA, context);
  }

  return startBiddingRound(nextState, position, optionA, needers, context);
}

export function finishMatch(
  state: AuctionMatchState,
  contextInput?: AuctionEngineContext
): AuctionMatchState {
  const context = resolveAuctionContext(contextInput);
  return touch({
    ...state,
    phase: 'finished',
    currentRound: null,
    soloPick: null,
    rankings: rankAuctionPlayers(state.seats),
  }, context);
}

function requireCurrentRound(state: AuctionMatchState): AuctionRoundState {
  if (!state.currentRound) throw new AuctionInvalidActionError('No active auction round');
  return state.currentRound;
}

function requireBiddingRound(state: AuctionMatchState): AuctionRoundState {
  const round = requireCurrentRound(state);
  if (state.phase !== 'bidding') {
    throw new AuctionInvalidActionError('No active bidding round');
  }
  return round;
}

function requireCurrentTurnPlayer(state: AuctionMatchState, seatId: string): AuctionPlayer {
  const round = requireBiddingRound(state);
  if (round.currentTurnSeatId !== seatId) {
    throw new AuctionInvalidActionError('Not this seat turn');
  }
  const player = state.seats.find((seat) => seat.seatId === seatId);
  if (!player || player.isEliminated || !needsPosition(player, round.positionGroup)) {
    throw new AuctionInvalidActionError('Seat cannot bid this round');
  }
  if (round.foldedSeatIds.includes(seatId)) {
    throw new AuctionInvalidActionError('Seat already folded');
  }
  return player;
}

function getRemainingBidders(round: AuctionRoundState, players: readonly AuctionPlayer[]): AuctionPlayer[] {
  return round.turnOrder
    .filter((seatId) => !round.foldedSeatIds.includes(seatId))
    .map((seatId) => players.find((player) => player.seatId === seatId))
    .filter((player): player is AuctionPlayer => (
      Boolean(player)
      && !player!.isEliminated
      && needsPosition(player!, round.positionGroup)
    ));
}

function getNextBidderSeatId(round: AuctionRoundState, players: readonly AuctionPlayer[]): string | null {
  const startIndex = round.currentTurnSeatId ? round.turnOrder.indexOf(round.currentTurnSeatId) : -1;
  const noBidYet = !round.highestBidderSeatId;

  for (let step = 1; step <= round.turnOrder.length; step++) {
    const seatId = round.turnOrder[(startIndex + step) % round.turnOrder.length];
    if (round.foldedSeatIds.includes(seatId)) continue;
    if (seatId === round.highestBidderSeatId) continue;

    const player = players.find((entry) => entry.seatId === seatId);
    if (!player || player.isEliminated || !needsPosition(player, round.positionGroup)) continue;
    if (noBidYet && getMaxBid(player.budget, getEmptySlots(player.team)) < round.startingPrice) continue;

    return seatId;
  }

  return null;
}

function createCompletedSoloPickRound(
  state: AuctionMatchState,
  selected: AuctionSoloPickOptionState,
  context: ResolvedAuctionEngineContext
): AuctionRoundState {
  if (!state.soloPick) throw new AuctionInvalidActionError('No active solo pick');
  const now = context.nowIso();
  const seatId = state.soloPick.playerSeatId;
  const footballer = selected.footballer;
  return {
    roundId: context.createId('round'),
    roundIndex: state.completedRounds.length + 1,
    positionGroup: state.soloPick.positionGroup,
    footballer,
    clueRevealIndex: footballer.clues?.length ?? 0,
    bids: [{ seatId, amount: 0, placedAt: now }],
    highestBidderSeatId: seatId,
    highestBid: 0,
    startingPrice: footballer.startingPrice,
    winnerSeatId: seatId,
    winningBid: 0,
    revealed: true,
    turnOrder: [seatId],
    currentTurnSeatId: null,
    foldedSeatIds: [],
    turnEndsAt: null,
    startedAt: now,
    updatedAt: now,
  };
}

function getAvailableFootballers(
  cards: AuctionCardPool,
  position: PositionGroup,
  usedClueCardIds: readonly string[]
): AuctionFootballer[] {
  const used = new Set(usedClueCardIds);
  return (cards[position] ?? []).filter((card) => !card.clueCardId || !used.has(card.clueCardId));
}

export function getTurnMs(round: AuctionRoundState): number {
  return round.highestBidderSeatId ? RAISE_TURN_MS : OPENING_TURN_MS;
}

function appendUsedClueCardId(
  usedClueCardIds: readonly string[],
  footballer: AuctionFootballer
): string[] {
  if (!footballer.clueCardId || usedClueCardIds.includes(footballer.clueCardId)) {
    return [...usedClueCardIds];
  }
  return [...usedClueCardIds, footballer.clueCardId];
}

function addMs(date: Date, ms: number): string {
  return new Date(date.getTime() + ms).toISOString();
}

function touch(state: AuctionMatchState, context: ResolvedAuctionEngineContext): AuctionMatchState {
  return {
    ...state,
    updatedAt: context.nowIso(),
  };
}

function pickOne<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
