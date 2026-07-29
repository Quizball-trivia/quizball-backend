import { harnessDelayMs } from '../../core/harness-timing.js';
import { logger } from '../../core/logger.js';
import { shuffle } from '../../core/rng.js';
import {
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
  hasLastPlayerStanding,
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
  AuctionMatchStateStaleError,
  saveAuctionMatchMutation,
  skipAuctionMatchMutation,
} from '../../modules/auction/auction-state.store.js';
import type { AuctionFootballer, PositionGroup } from '../../modules/auction/auction.types.js';
import {
  persistFinishedAuctionMatch,
  type AuctionMatchRewards,
} from './auction-persistence.service.js';
import { getAuctionPause } from './auction-disconnect-state.service.js';
import { releaseAuctionReservations } from './auction-bot-reservation.service.js';
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
import { scheduleAuctionAdvanceRetryTimer } from './auction-advance-retry-timer.js';
import { requirePublicRound } from './auction-realtime-payloads.js';
import {
  AUCTION_FIRST_ROUND_UI_READY_CEILING_MS,
  openAuctionUiReadyGate,
} from './auction-ui-ready.service.js';
import { resolveRealtimeAuctionContext } from './auction-engine-context.js';

const AUCTION_REVEAL_UI_READY_CEILING_MS = 6_000;
const AUCTION_CONTENT_FETCH_ATTEMPTS = 3;
const AUCTION_CONTENT_FETCH_RETRY_MS = 100;
// A human's solo pick auto-resolves after this long (bots pick instantly).
// Without a deadline a frozen tab / silent drop froze the whole match forever.
const AUCTION_SOLO_PICK_TIMEOUT_MS = 30_000;
// Auto-selection on timeout matches the bot default.
const AUCTION_SOLO_PICK_DEFAULT_OPTION = 'B' as const;

export type AuctionSoloPickTimeoutTimerPayload = Extract<RealtimeTimerPayload, { kind: 'auction_solo_pick_timeout' }>;

export interface AuctionMatchFlowOptions {
  now?: Date;
  context?: AuctionEngineContext;
  finishReason?: AuctionMatchFinishReason;
}

export type AuctionMatchFinishReason =
  | 'normal'
  | 'no_more_content'
  | 'no_live_humans'
  | 'forfeit'
  | 'last_player_standing';

interface AuctionStepResult {
  state: AuctionMatchState;
  finishReason?: AuctionMatchFinishReason;
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
  if (state.phase !== 'finished' && !hasLiveAuctionHuman(state)) {
    const finished = await finishAuctionMatchWithoutLiveHumans(state, options);
    return emitAuctionStepStarted(io, finished, { ...options, finishReason: 'no_live_humans' });
  }
  if (state.phase === 'bidding') return state;

  if (state.phase === 'reveal' && state.currentRound) {
    emitRoundRevealed(io, state);
    openAuctionUiReadyGate({
      io,
      state,
      phase: 'reveal',
      ceilingMs: AUCTION_REVEAL_UI_READY_CEILING_MS,
      // The gate owns error observation and retries a match-lock collision after
      // its opener has unwound; return the promise so it can do both.
      dispatch: () => advanceAuctionMatchFlowFromRevealGate(io, state, options),
    });
    return state;
  }

  const advanced = await advanceToNextAuctionStep(state, options);
  return emitAuctionStepStarted(io, advanced.state, {
    ...options,
    finishReason: advanced.finishReason ?? options.finishReason,
  });
}

export async function advanceAuctionMatchFlowFromRevealGate(
  io: QuizballServer,
  state: AuctionMatchState,
  options: AuctionMatchFlowOptions
): Promise<void> {
  // A paused match (player in their disconnect grace window) must not advance
  // past the reveal — the gate's 6s ceiling is far shorter than the 30s grace.
  // Defer past the grace instant; the grace-forfeit and resume paths both
  // re-drive the reveal advance themselves, so this retry is only a fallback.
  const pause = await getAuctionPause(state.matchId);
  if (pause) {
    const pauseUntilMs = Date.parse(pause.pauseUntil);
    const retryInMs = Math.max(0, (Number.isFinite(pauseUntilMs) ? pauseUntilMs : Date.now()) - Date.now()) + 2_000;
    logger.debug({ matchId: state.matchId }, 'Auction reveal advance deferred (match paused)');
    await scheduleAuctionAdvanceRetryTimer(
      state.matchId,
      'reveal',
      new Date(Date.now() + retryInMs),
    );
    return;
  }

  const advanced = await advanceToNextAuctionStep(state, options);
  await emitAuctionStepStarted(io, advanced.state, {
    ...options,
    finishReason: advanced.finishReason ?? options.finishReason,
  });
}

export async function handleAuctionSoloPickSelection(
  io: QuizballServer,
  state: AuctionMatchState,
  seatId: string,
  option: 'A' | 'B',
  options: AuctionMatchFlowOptions = {}
): Promise<AuctionMatchState> {
  const context = resolveRealtimeAuctionContext(options);
  const saved = await auctionStateStore.mutate(state.matchId, (current) => {
    if (current.version !== state.version) {
      throw new AuctionMatchStateStaleError(state.matchId, state.version, current.version);
    }
    const selected = selectSoloPickOption(current, seatId, option, context);
    return saveAuctionMatchMutation(selected, (savedState) => savedState);
  }, {
    now: context.now,
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
  const context = resolveRealtimeAuctionContext(options);
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
      ceilingMs: state.currentRound.roundIndex === 1
        ? AUCTION_FIRST_ROUND_UI_READY_CEILING_MS
        : undefined,
      dispatch: () => scheduleAuctionClueRevealTimerFromFlow(state, options),
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
    // Persist first so we know each human's coin + Auction Points reward, then
    // emit it with the finish payload. Persistence is best-effort (its own
    // try/catch) and returns empty rewards on failure, so a DB hiccup just means
    // no reward shown — never blocks the finish broadcast.
    const rewards = await persistFinishedAuctionMatch(state);
    const finishReason = options.finishReason ?? inferAuctionMatchFinishReason(state);
    logger.info(
      { matchId: state.matchId, finishReason },
      'Auction match finished'
    );
    emitMatchFinished(io, state, rewards);
    await auctionStateStore.clearIndexes(state);
    // Terminal choke point for EVERY finish — the normal 11-round end and the
    // last-human-forfeit finish both land here — so persistent-bot reservations
    // are freed exactly once, after persistence has written their history rows.
    // Idempotent and never throws; a no-op when no persistent bot was seated.
    await releaseAuctionReservations(
      state.matchId,
      finishReason === 'normal' || finishReason === 'no_more_content' ? 'finish' : 'forfeit_finish',
    );
  }
  return state;
}

async function advanceToNextAuctionStep(
  state: AuctionMatchState,
  options: AuctionMatchFlowOptions
): Promise<AuctionStepResult> {
  const context = resolveRealtimeAuctionContext(options);
  const nextBase = closeResolvedRound(state);
  const nextStep = await createNextStepState(nextBase, context);
  const nextState = nextStep.state;

  if (nextState === state) return nextStep;
  if (nextState.version !== state.version) return nextStep;

  const saved = await auctionStateStore.mutate(state.matchId, (current) => {
    if (current.version !== state.version) {
      // A concurrent mutation advanced the match first. Return ITS persisted
      // state — never the locally computed nextState, which was never saved
      // (emitting a phantom state desyncs clients from the store).
      return skipAuctionMatchMutation(current);
    }

    return saveAuctionMatchMutation(nextState, (saved) => saved);
  }, {
    now: context.now,
    onMissingState: () => state,
  });
  return { state: saved, finishReason: nextStep.finishReason };
}

async function createNextStepState(
  state: AuctionMatchState,
  context: ResolvedAuctionEngineContext
): Promise<AuctionStepResult> {
  if (state.phase === 'finished' || state.phase === 'clue_reveal' || state.phase === 'solo_pick') {
    return { state };
  }

  if (!hasLiveAuctionHuman(state)) {
    return { state: finishMatch(state, context), finishReason: 'no_live_humans' };
  }

  const activePlayers = state.seats.filter(canPlayerContinue);
  if (activePlayers.length === 0) {
    return { state: finishMatch(state, context), finishReason: 'normal' };
  }

  const positions = shuffle(
    POSITION_GROUPS.filter((position) => activePlayers.some((player) => needsPosition(player, position))),
    context.random
  );
  const locale = resolveLocale(state);
  const humanUserIds = auctionHumanUserIds(state);
  const recentlySeenFootballPlayerIds = await getRecentlySeenFootballPlayerIds(
    state.matchId,
    humanUserIds
  );

  for (const position of positions) {
    const needers = activePlayers.filter((player) => needsPosition(player, position));
    const optionA = await getNextPublishedCard(
      locale,
      position,
      state.usedClueCardIds,
      recentlySeenFootballPlayerIds
    );
    if (!optionA) continue;

    if (needers.length === 1) {
      const optionBExcludeIds = optionA.clueCardId
        ? [...state.usedClueCardIds, optionA.clueCardId]
        : state.usedClueCardIds;
      const optionB = await getNextPublishedCard(
        locale,
        position,
        optionBExcludeIds,
        recentlySeenFootballPlayerIds
      );
      // Both solo-pick options are shown to the picking human, so both count as seen.
      recordSeenAuctionCards(state.matchId, humanUserIds, [optionA, optionB ?? optionA]);
      return {
        state: startSoloPick(state, needers[0].seatId, position, optionA, optionB ?? optionA, context),
      };
    }

    recordSeenAuctionCards(state.matchId, humanUserIds, [optionA]);
    return { state: startBiddingRound(state, position, optionA, needers, context) };
  }

  return { state: finishMatch(state, context), finishReason: 'no_more_content' };
}

function hasLiveAuctionHuman(state: AuctionMatchState): boolean {
  return state.seats.some((seat) => (
    !seat.isBot && Boolean(seat.userId) && !seat.forfeited && !seat.isEliminated
  ));
}

async function finishAuctionMatchWithoutLiveHumans(
  state: AuctionMatchState,
  options: AuctionMatchFlowOptions
): Promise<AuctionMatchState> {
  const context = resolveRealtimeAuctionContext(options);
  return auctionStateStore.mutate(state.matchId, (current) => {
    if (current.phase === 'finished') return skipAuctionMatchMutation(current);
    if (hasLiveAuctionHuman(current)) return skipAuctionMatchMutation(current);
    return saveAuctionMatchMutation(finishMatch(current, context), (saved) => saved);
  }, {
    now: context.now,
    onMissingState: () => state,
  });
}

/** Seated humans with a real user id — bots have no history worth tracking. */
function auctionHumanUserIds(state: AuctionMatchState): string[] {
  return state.seats
    .filter((seat) => !seat.isBot && Boolean(seat.userId))
    .map((seat) => seat.userId as string);
}

/**
 * Cross-match history for this match's humans. Best-effort: a failure here must
 * never block a round, so it degrades to "no history" and the pick proceeds.
 */
async function getRecentlySeenFootballPlayerIds(
  matchId: string,
  humanUserIds: string[]
): Promise<string[]> {
  if (humanUserIds.length === 0) return [];
  try {
    return await auctionContentService.getRecentlySeenFootballPlayerIds(humanUserIds);
  } catch (error) {
    logger.warn(
      { error, matchId },
      'getRecentlySeenFootballPlayerIds failed; picking without history exclusion'
    );
    return [];
  }
}

/**
 * Fire-and-forget: record the exact shown card IDs. The history read joins each
 * card back to its football player, which makes locale/variant repeats collapse
 * to the same no-repeat key without changing the existing history table.
 */
function recordSeenAuctionCards(
  matchId: string,
  humanUserIds: string[],
  cards: ReadonlyArray<AuctionFootballer | null>
): void {
  if (humanUserIds.length === 0) return;
  const clueCardIds = [...new Set(
    cards.flatMap((card) => (card?.clueCardId ? [card.clueCardId] : []))
  )];
  if (clueCardIds.length === 0) return;

  void auctionContentService.recordSeenClueCards(humanUserIds, clueCardIds).catch((error) => {
    logger.warn({ error, matchId, clueCardIds }, 'Failed to record seen auction clue cards');
  });
}

async function getNextPublishedCard(
  locale: AuctionContentLocale,
  positionGroup: PositionGroup,
  excludeClueCardIds: readonly string[],
  excludeRecentlySeenFootballPlayerIds: readonly string[] = []
): Promise<AuctionFootballer | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= AUCTION_CONTENT_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await auctionContentService.findRandomPublishedAuctionCardExcludingSeen({
        locale,
        positionGroup,
        excludeClueCardIds: [...excludeClueCardIds],
        excludeRecentlySeenFootballPlayerIds:
          excludeRecentlySeenFootballPlayerIds.length > 0
          ? [...excludeRecentlySeenFootballPlayerIds]
          : undefined,
      });
    } catch (error) {
      lastError = error;
      if (
        attempt < AUCTION_CONTENT_FETCH_ATTEMPTS
        && isRetryableAuctionContentError(error)
      ) {
        await delay(AUCTION_CONTENT_FETCH_RETRY_MS);
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new AuctionContentUnavailableError({ locale, positionGroup });
}

const TRANSIENT_AUCTION_DATABASE_ERROR_CODES = new Set([
  'DB_OVERLOADED',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

function isRetryableAuctionContentError(error: unknown, depth = 0): boolean {
  if (error instanceof AuctionContentUnavailableError) return true;
  if (!error || depth > 3 || typeof error !== 'object') return false;

  const candidate = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
    details?: unknown;
    errors?: unknown;
  };
  if (
    typeof candidate.code === 'string'
    && TRANSIENT_AUCTION_DATABASE_ERROR_CODES.has(candidate.code.toUpperCase())
  ) {
    return true;
  }
  if (
    typeof candidate.message === 'string'
    && /(?:database|db|postgres|pool|pooler|connection).*(?:closed|destroyed|exhausted|overloaded|saturated|timeout|timed out|unavailable)/i.test(
      candidate.message,
    )
  ) {
    return true;
  }
  if (isRetryableAuctionContentError(candidate.cause, depth + 1)) return true;
  if (isRetryableAuctionContentError(candidate.details, depth + 1)) return true;
  return Array.isArray(candidate.errors)
    && candidate.errors.some((nested) => isRetryableAuctionContentError(nested, depth + 1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, harnessDelayMs(ms, 1));
    timer.unref?.();
  });
}

function inferAuctionMatchFinishReason(state: AuctionMatchState): AuctionMatchFinishReason {
  if (hasLastPlayerStanding(state.seats)) return 'last_player_standing';
  if (!hasLiveAuctionHuman(state)) return 'no_live_humans';
  if (state.seats.some((seat) => seat.forfeited)) return 'forfeit';
  return 'normal';
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
  rewards: AuctionMatchRewards = { coinsByUserId: {} },
): void {
  if (!state.rankings) return;
  const publicState = toPublicAuctionMatchState(state);
  // Emitting the finish event is the one thing that must never throw, so a
  // partial/absent rewards object degrades to "no reward shown". `apByUserId`
  // stays undefined when the match awarded no AP (friendly), which the client
  // reads as "hide AP" — distinct from a present map containing a 0.
  const coinsByUserId = rewards?.coinsByUserId ?? {};
  const apByUserId = rewards?.apByUserId;

  io.to(`match:${state.matchId}`).emit('auction:match_finished', {
    matchId: state.matchId,
    rankings: state.rankings,
    winnerSeatId: state.rankings[0]?.seatId ?? null,
    state: publicState,
    stateVersion: state.version,
    coinsByUserId,
    apByUserId,
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
