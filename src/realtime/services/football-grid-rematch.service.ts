import { randomUUID } from 'node:crypto';
import { AuthorizationError, ConflictError, NotFoundError } from '../../core/errors.js';
import {
  trackFootballGridMatchFound,
  trackFootballGridRematchResponse,
} from '../../core/analytics/game-events.js';
import { logger } from '../../core/logger.js';
import {
  footballGridRepo,
  footballGridService,
  FOOTBALL_GRID_HANDOFF_MS,
  type FootballGridState,
} from '../../modules/football-grid/index.js';
import { scheduleRealtimeTimer } from '../realtime-timer-scheduler.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { emitLobbyState } from '../lobby-utils.js';
import { footballGridRealtimeService } from './football-grid-realtime.service.js';
import { userSessionGuardService } from './user-session-guard.service.js';

const TIMER_KIND = 'football_grid_rematch_expiry' as const;
const RECOVERY_INTERVAL_MS = 1_000;
let recoveryTimer: NodeJS.Timeout | null = null;
let recoveryRunning = false;

function emitState(io: QuizballServer, userIds: string[], payload: {
  seriesId: string;
  seriesVersion: number;
  status: 'pending' | 'started' | 'declined' | 'expired';
  acceptedUserIds: string[];
  expiresAt: string | null;
}): void {
  for (const userId of userIds) io.to(`user:${userId}`).emit('grid:rematch_state', payload);
}

// Repo-level rematch guards throw plain Errors. Map the known codes to typed
// app errors so clients receive actionable gridCodes instead of a generic
// GRID_INTERNAL_ERROR (e.g. both players tapping Accept at the same instant).
function toRematchDomainError(error: unknown): Error {
  if (!(error instanceof Error)) return error instanceof Error ? error : new ConflictError('Rematch request failed');
  switch (error.message) {
    case 'REMATCH_UNAVAILABLE':
      return new NotFoundError('Rematch is not available for this match', { gridCode: 'REMATCH_UNAVAILABLE' });
    case 'REMATCH_EXPIRED':
      return new ConflictError('The rematch window has expired', { gridCode: 'REMATCH_EXPIRED' });
    case 'REMATCH_ALREADY_DECIDED':
      return new ConflictError('You have already responded to this rematch', { gridCode: 'REMATCH_ALREADY_DECIDED' });
    case 'STALE_SERIES':
      return new ConflictError('Rematch state changed. Please try again.', { gridCode: 'STALE_SERIES' });
    case 'SERIES_CLOSED':
      return new ConflictError('This series was already closed', { gridCode: 'SERIES_CLOSED' });
    case 'NOT_PARTICIPANT':
      return new AuthorizationError('Not a Football Grid participant');
    default:
      return error;
  }
}

export const footballGridRematchService = {
  async rearmPending(): Promise<void> {
    let cursor: string | null = null;
    while (true) {
      const pending = await footballGridRepo.listPendingRematches(200, cursor);
      await Promise.all(pending.map((rematch) => scheduleRealtimeTimer(
        TIMER_KIND,
        rematch.seriesId,
        new Date(Math.max(Date.now(), Date.parse(rematch.expiresAt))),
        {
          kind: TIMER_KIND,
          seriesId: rematch.seriesId,
          expectedSeriesVersion: rematch.seriesVersion,
        },
      )));
      if (pending.length < 200) return;
      cursor = pending[pending.length - 1].seriesId;
    }
  },

  startRecovery(io: QuizballServer): void {
    if (recoveryTimer) return;
    const run = async () => {
      if (recoveryRunning) return;
      recoveryRunning = true;
      try {
        const due = await footballGridRepo.listDueRematches();
        for (const rematch of due) {
          await this.expire(io, rematch.seriesId, rematch.seriesVersion).catch(() => {});
        }
      } finally {
        recoveryRunning = false;
      }
    };
    recoveryTimer = setInterval(() => void run().catch(() => {}), RECOVERY_INTERVAL_MS);
    recoveryTimer.unref?.();
    void this.rearmPending().catch(() => {});
    void run().catch(() => {});
  },

  async accept(io: QuizballServer, socket: QuizballSocket, input: {
    matchId: string;
    commandId: string;
    expectedSeriesVersion: number;
  }): Promise<void> {
    const userId = socket.data.user.id;
    const accepted = await userSessionGuardService.withUserSessionLock(userId, async () => {
      const offer = await footballGridRepo.offerRematch({
        ...input,
        userId,
        proposedPairingToken: randomUUID(),
      }).catch((error) => {
        throw toRematchDomainError(error);
      });
      let fenced = false;
      try {
        fenced = await userSessionGuardService.claimRematchActivityFence({
          userId,
          fenceToken: offer.pairingToken,
          allowedLobbyId: offer.lobbyId,
          ttlMs: Math.max(1_000, Date.parse(offer.expiresAt) - Date.now()),
        });
      } catch (error) {
        await footballGridRepo.closeRematchAfterFailure(offer.seriesId, offer.pairingToken);
        throw error;
      }
      if (!fenced) {
        await footballGridRepo.closeRematchAfterFailure(offer.seriesId, offer.pairingToken);
        throw new ConflictError('You entered another activity before the rematch was reserved', {
          gridCode: 'REMATCH_ACTIVITY_CONFLICT',
        });
      }
      return offer;
    }, { waitMs: 1_200 });
    if (!accepted) {
      throw new ConflictError('Rematch state is changing. Please retry.', {
        gridCode: 'REMATCH_TRANSITION_IN_PROGRESS',
      });
    }
    trackFootballGridRematchResponse({
      userId,
      matchId: input.matchId,
      seriesId: accepted.seriesId,
      response: 'accepted',
      occurredAt: accepted.decisionAt,
    });
    const userIds = accepted.players.map((player) => player.userId);
    emitState(io, userIds, {
      seriesId: accepted.seriesId,
      seriesVersion: accepted.seriesVersion,
      status: 'pending',
      acceptedUserIds: accepted.acceptedUserIds,
      expiresAt: accepted.expiresAt,
    });
    await scheduleRealtimeTimer(
      TIMER_KIND,
      accepted.seriesId,
      new Date(accepted.expiresAt),
      { kind: TIMER_KIND, seriesId: accepted.seriesId, expectedSeriesVersion: accepted.seriesVersion },
    );
    if (!accepted.readyToCreate) return;
    if (!await userSessionGuardService.ownsActivityFences(userIds, accepted.pairingToken)) {
      const [closedVersion] = await Promise.all([
        footballGridRepo.closeRematchAfterFailure(accepted.seriesId, accepted.pairingToken),
        userSessionGuardService.releaseActivityFences(userIds, accepted.pairingToken),
      ]);
      if (typeof closedVersion === 'number') {
        emitState(io, userIds, {
          seriesId: accepted.seriesId,
          seriesVersion: closedVersion,
          status: 'declined',
          acceptedUserIds: [],
          expiresAt: null,
        });
      }
      throw new ConflictError('A rematch participant entered another activity', {
        gridCode: 'REMATCH_ACTIVITY_CONFLICT',
      });
    }
    let state: FootballGridState;
    try {
      const createdState = await userSessionGuardService.withUserSessionLocks(userIds, async () => {
        if (!await userSessionGuardService.renewActivityFences(userIds, accepted.pairingToken, 30_000)) {
          throw new ConflictError('A rematch participant entered another activity', {
            gridCode: 'REMATCH_ACTIVITY_CONFLICT',
          });
        }
        await footballGridRepo.createPairing({
          pairingToken: accepted.pairingToken,
          searchAId: accepted.seriesId,
          searchBId: accepted.seriesId,
          userAId: accepted.players[0].userId,
          userBId: accepted.players[1].userId,
          opponentType: 'human',
        });
        const opener = accepted.players.find((player) => player.seat === accepted.openerSeat)!;
        // A rematch stays on the pack the series started on.
        const theme = await footballGridRepo.getMatchTheme(input.matchId);
        return (await footballGridService.createMatch({
          pairingToken: accepted.pairingToken,
          lobbyId: accepted.lobbyId,
          origin: accepted.origin,
          theme,
          players: accepted.players,
          openerUserId: opener.userId,
          seriesId: accepted.seriesId,
          rematchOfMatchId: input.matchId,
          rematchIndex: accepted.rematchIndex,
        })).state;
      }, { waitMs: 1_200 });
      if (!createdState) {
        throw new ConflictError('Rematch state is changing. Please retry.', {
          gridCode: 'REMATCH_TRANSITION_IN_PROGRESS',
        });
      }
      state = createdState;
    } catch (error) {
      const closedVersion = await footballGridRepo
        .closeRematchAfterFailure(accepted.seriesId, accepted.pairingToken)
        .catch(() => null);
      await Promise.all([
        footballGridRepo.markPairingFailed(
          accepted.pairingToken,
          error instanceof Error ? error.message : 'rematch_creation_failed',
        ).catch(() => {}),
        userSessionGuardService.releaseActivityFences(userIds, accepted.pairingToken).catch(() => {}),
      ]);
      if (typeof closedVersion === 'number') {
        emitState(io, userIds, {
          seriesId: accepted.seriesId,
          seriesVersion: closedVersion,
          status: 'declined',
          acceptedUserIds: [],
          expiresAt: null,
        });
      }
      throw toRematchDomainError(error);
    }

    // The durable match now exists. Network delivery is deliberately outside
    // the creation-failure boundary: a Socket.IO failure must never close the
    // committed rematch or tell clients it was declined. The handoff outbox
    // continuously redelivers the match until both players acknowledge it.
    await userSessionGuardService.releaseActivityFences(userIds, accepted.pairingToken);
    emitState(io, userIds, {
      seriesId: accepted.seriesId,
      seriesVersion: accepted.seriesVersion + 1,
      status: 'started',
      acceptedUserIds: userIds,
      expiresAt: null,
    });
    const matchedAt = new Date(Date.parse(state.phaseDeadlineAt ?? '') - FOOTBALL_GRID_HANDOFF_MS);
    for (const participant of state.players.filter((player) => !player.isBot)) {
      trackFootballGridMatchFound({
        userId: participant.userId,
        matchId: state.matchId,
        origin: accepted.origin,
        opponentType: 'human',
        boardId: state.board.boardId,
        boardVersion: state.board.boardVersion,
        occurredAt: matchedAt,
      });
    }
    await footballGridRealtimeService.emitMatchFound(io, state).catch((error) => {
      logger.warn({ error, matchId: state.matchId }, 'Football Grid rematch handoff deferred to recovery');
    });
  },

  async decline(io: QuizballServer, socket: QuizballSocket, input: {
    matchId: string;
    expectedSeriesVersion: number;
  }): Promise<void> {
    const state = await footballGridService.getState(input.matchId, socket.data.user.id);
    const declined = await footballGridRepo.declineRematch({ ...input, userId: socket.data.user.id })
      .catch((error) => {
        throw toRematchDomainError(error);
      });
    trackFootballGridRematchResponse({
      userId: socket.data.user.id,
      matchId: input.matchId,
      seriesId: declined.seriesId,
      response: 'declined',
      occurredAt: declined.decisionAt,
    });
    if (declined.pairingToken) {
      await userSessionGuardService.releaseActivityFences(declined.userIds, declined.pairingToken);
    }
    if (declined.lobbyId) await emitLobbyState(io, declined.lobbyId);
    await Promise.all(declined.userIds.map((userId) => userSessionGuardService.emitState(io, userId)));
    emitState(io, state.players.map((player) => player.userId), {
      seriesId: declined.seriesId,
      seriesVersion: input.expectedSeriesVersion + 1,
      status: 'declined',
      acceptedUserIds: [],
      expiresAt: null,
    });
  },

  async expire(io: QuizballServer, seriesId: string, expectedSeriesVersion: number): Promise<void> {
    const expired = await footballGridRepo.expireRematch(seriesId, expectedSeriesVersion);
    if (!expired) return;
    const userIds = expired.userIds.length > 0
      ? expired.userIds
      : await footballGridRepo.getSeriesUserIds(seriesId);
    if (expired.pairingToken) {
      await userSessionGuardService.releaseActivityFences(userIds, expired.pairingToken);
    }
    if (expired.lobbyId) await emitLobbyState(io, expired.lobbyId);
    await Promise.all(userIds.map((userId) => userSessionGuardService.emitState(io, userId)));
    emitState(io, userIds, {
      seriesId,
      seriesVersion: expectedSeriesVersion + 1,
      status: 'expired',
      acceptedUserIds: [],
      expiresAt: null,
    });
  },
};
