import { logger } from '../../core/logger.js';
import {
  auctionStateStore,
} from '../../modules/auction/auction-state.store.js';
import {
  findAuctionSeatByUserId,
  toPublicAuctionMatchState,
  type AuctionMatchState,
} from '../../modules/auction/auction-match-state.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { scheduleAuctionBotActionTimer } from './auction-bot.service.js';
import { scheduleAuctionClueRevealTimer } from './auction-clue-timer.service.js';
import {
  advanceAuctionMatchFlowAfterMutation,
  scheduleAuctionSoloPickTimeoutTimer,
} from './auction-match-flow.service.js';
import { scheduleAuctionTurnTimeoutTimer } from './auction-turn.service.js';
import { emitAuctionUiReadyGateState } from './auction-ui-ready.service.js';
import {
  handleAuctionSocketDisconnect as handleAuctionDisconnectGrace,
  buildAuctionRejoinAvailable,
} from './auction-disconnect.service.js';
import { getAuctionDisconnectedUser } from './auction-disconnect-state.service.js';

const BOOT_AUCTION_REARM_DELAY_MS = 3_000;
const BOOT_AUCTION_REARM_BATCH = 500;

let bootAuctionRearmTimer: NodeJS.Timeout | null = null;

export interface AuctionLifecycleRearmSummary {
  scanned: number;
  rearmed: number;
  finished: number;
  missing: number;
  failed: number;
}

export const auctionLifecycleService = {
  async rejoinActiveAuctionMatchOnConnect(
    io: QuizballServer,
    socket: QuizballSocket
  ): Promise<boolean> {
    const userId = socket.data.user?.id;
    if (!userId) return false;

    const matchId = await auctionStateStore.getActiveMatchIdForUser(userId);
    if (!matchId) return false;

    const state = await auctionStateStore.load(matchId);
    if (!state) {
      await Promise.all([
        auctionStateStore.clearIndexes(matchId),
        auctionStateStore.clearUserMatchIndex(userId, matchId),
      ]);
      return false;
    }

    if (state.phase === 'finished') {
      await auctionStateStore.clearIndexes(state);
      return false;
    }

    const seat = findAuctionSeatByUserId(state, userId);
    if (!seat || seat.isBot) {
      await auctionStateStore.clearUserMatchIndex(userId, matchId);
      return false;
    }

    // If the match is paused because THIS user disconnected, don't auto-join.
    // Mirror ranked: prompt with auction:rejoin_available and wait for the
    // client to opt in via auction:rejoin (→ handleAuctionRejoin).
    const disconnected = await getAuctionDisconnectedUser(state.matchId, userId);
    if (disconnected) {
      const available = buildAuctionRejoinAvailable(disconnected);
      socket.emit('auction:rejoin_available', { ...available, matchId: state.matchId });
      logger.info(
        { matchId: state.matchId, userId, seatId: seat.seatId },
        'Auction rejoin available (paused on self-disconnect); awaiting client opt-in'
      );
      return true;
    }

    socket.data.lobbyId = undefined;
    socket.data.matchId = state.matchId;
    socket.join(`match:${state.matchId}`);

    const publicState = toPublicAuctionMatchState(state);
    socket.emit('auction:state', {
      matchId: state.matchId,
      state: publicState,
      stateVersion: state.version,
      serverNow: new Date().toISOString(),
    });

    await ensureAuctionActiveTimers(io, state);
    logger.info(
      { matchId: state.matchId, userId, phase: state.phase, stateVersion: state.version },
      'Rejoined active auction match'
    );
    return true;
  },

  async handleAuctionSocketDisconnect(
    io: QuizballServer,
    socket: QuizballSocket
  ): Promise<void> {
    // Resolve the match from the socket binding OR the user→match index. A
    // socket that re-authenticated but never rebound to the match (e.g. a
    // token-refresh flap) has no socket.data.matchId — without the fallback its
    // disconnect would be a silent no-op (no pause, no grace) and the match
    // would hang until Redis TTLs expire. Same pattern ranked fixed with its
    // getActiveMatchForUser fallback.
    const userId = socket.data.user?.id;
    const matchId = socket.data.matchId
      ?? (userId
        ? await auctionStateStore.getActiveMatchIdForUser(userId).catch(() => null)
        : null);
    if (!matchId) return;

    let state = await auctionStateStore.load(matchId);
    if (!state) return;
    await handleAuctionDisconnectGrace(io, socket);
    state = await auctionStateStore.load(matchId);
    if (!state) return;
    await ensureAuctionActiveTimers(io, state);
  },

  async rearmActiveAuctionTimersOnBoot(io: QuizballServer): Promise<AuctionLifecycleRearmSummary> {
    const summary: AuctionLifecycleRearmSummary = {
      scanned: 0,
      rearmed: 0,
      finished: 0,
      missing: 0,
      failed: 0,
    };

    let matchIds: string[];
    try {
      matchIds = await auctionStateStore.listActiveMatchIds();
    } catch (error) {
      logger.warn({ error }, 'Auction boot timer re-arm scan failed');
      return summary;
    }

    for (const matchId of matchIds.slice(0, BOOT_AUCTION_REARM_BATCH)) {
      summary.scanned += 1;
      try {
        const state = await auctionStateStore.load(matchId);
        if (!state) {
          summary.missing += 1;
          await auctionStateStore.clearIndexes(matchId);
          continue;
        }
        if (state.phase === 'finished') {
          summary.finished += 1;
          await auctionStateStore.clearIndexes(state);
          continue;
        }
        if (await ensureAuctionActiveTimers(io, state)) {
          summary.rearmed += 1;
        }
      } catch (error) {
        summary.failed += 1;
        logger.warn({ error, matchId }, 'Auction boot timer re-arm failed for match');
      }
    }

    logger.info(summary, 'Auction boot timer re-arm completed for active matches');
    return summary;
  },
};

export async function ensureAuctionActiveTimers(
  io: QuizballServer,
  state: AuctionMatchState
): Promise<boolean> {
  if (state.phase === 'clue_reveal' && state.currentRound) {
    if (emitAuctionUiReadyGateState(io, state, 'round')) return true;
    await scheduleAuctionClueRevealTimer(state);
    return true;
  }

  if (state.phase === 'bidding' && state.currentRound?.currentTurnSeatId) {
    if (emitAuctionUiReadyGateState(io, state, 'bidding')) return true;
    await scheduleAuctionTurnTimeoutTimer(state);
    await scheduleAuctionBotActionTimer(state);
    return true;
  }

  if (state.phase === 'solo_pick' && state.soloPick && !state.soloPick.selectedOption) {
    // Re-arm the human solo-pick deadline (survives restarts). Without this a
    // server restart during a human's solo pick left the match frozen forever.
    await scheduleAuctionSoloPickTimeoutTimer(state);
    return true;
  }

  if (state.phase === 'reveal' && state.currentRound) {
    // If a live gate exists (plain reconnect), just resend it. Otherwise the
    // gate + its ceiling timer were lost (server restart / crash) and the match
    // is frozen at reveal — re-open the gate so it advances. Without this the
    // match stays stuck and client ui_ready acks are ignored (no gate to match).
    if (emitAuctionUiReadyGateState(io, state, 'reveal')) return true;
    await advanceAuctionMatchFlowAfterMutation(io, state);
    return true;
  }

  if (state.phase === 'finished') {
    await auctionStateStore.clearIndexes(state);
  }
  return false;
}

export function scheduleBootAuctionTimerRearm(io: QuizballServer): void {
  if (bootAuctionRearmTimer) clearTimeout(bootAuctionRearmTimer);
  bootAuctionRearmTimer = setTimeout(() => {
    bootAuctionRearmTimer = null;
    void auctionLifecycleService.rearmActiveAuctionTimersOnBoot(io).catch((error) => {
      logger.warn({ error }, 'Auction boot timer re-arm crashed');
    });
  }, BOOT_AUCTION_REARM_DELAY_MS);
  bootAuctionRearmTimer.unref?.();
}

export function cancelBootAuctionTimerRearm(): void {
  if (bootAuctionRearmTimer) {
    clearTimeout(bootAuctionRearmTimer);
    bootAuctionRearmTimer = null;
  }
}
