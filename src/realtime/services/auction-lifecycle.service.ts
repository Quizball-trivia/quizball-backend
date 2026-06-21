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
import { scheduleAuctionTurnTimeoutTimer } from './auction-turn.service.js';
import { emitAuctionUiReadyGateState } from './auction-ui-ready.service.js';
import {
  handleAuctionSocketDisconnect as handleAuctionDisconnectGrace,
  resumeAuctionUserIfDisconnected,
} from './auction-disconnect.service.js';

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

    await resumeAuctionUserIfDisconnected(io, socket, state);
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
    const matchId = socket.data.matchId;
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
