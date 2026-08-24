import { ErrorCode } from '../../core/errors.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { auctionStateStore } from '../../modules/auction/auction-state.store.js';
import {
  findAuctionSeatByUserId,
  toPublicAuctionMatchState,
} from '../../modules/auction/auction-match-state.js';
import type { AuctionContentLocale } from '../../modules/auction/index.js';
import { AUCTION_SEAT_COUNT } from '../../modules/auction/auction.constants.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type { AuctionStatePayload } from '../socket.types.js';
import { emitLobbyState } from '../lobby-utils.js';
import { warmupRealtimeService } from './warmup-realtime.service.js';
import {
  startAuctionMatchForHumans,
  type AuctionMatchHumanPlayer,
} from './auction-realtime.service.js';
import { toAuctionErrorPayload } from './auction-action-errors.js';

export interface StartAuctionMatchFromLobbyInput {
  lobbyId: string;
  hostUserId: string;
  locale?: AuctionContentLocale;
}

/**
 * Start a friendly auction match from a lobby. Mirrors the queue path: the
 * lobby's members take the human seats (host first) and the auction matchmaking
 * bot-backfill fills the rest, so clients receive the same
 * `auction:match_started` / `auction:round_started` stream the queue emits.
 *
 * Friendly: no tickets are consumed and no RP is settled — this path never
 * touches the store or ranked services, exactly like friendly possession. The
 * match is stamped `origin: 'lobby'` so it also awards no Auction Points.
 *
 * MUST be called while holding `lock:lobby:<lobbyId>`; the caller's lock is what
 * makes a double `lobby:start` idempotent.
 */
export async function startAuctionMatchFromLobby(
  io: QuizballServer,
  socket: QuizballSocket,
  input: StartAuctionMatchFromLobbyInput
): Promise<void> {
  const { lobbyId, hostUserId } = input;
  if (!config.AUCTION_ENABLED) {
    socket.emit('error', { code: 'AUCTION_DISABLED', message: 'Auction is temporarily unavailable' });
    return;
  }
  const members = await lobbiesRepo.listMembersWithUser(lobbyId);

  if (members.length < 1 || members.length > AUCTION_SEAT_COUNT) {
    socket.emit('error', {
      code: 'LOBBY_NOT_READY',
      message: `Auction supports 1 to ${AUCTION_SEAT_COUNT} players`,
    });
    return;
  }

  // Host takes seat 1; the rest keep their join order.
  const ordered = [
    ...members.filter((member) => member.user_id === hostUserId),
    ...members.filter((member) => member.user_id !== hostUserId),
  ];

  // A member already seated in a LIVE auction match cannot be seated again —
  // starting would leave them gated on two matches at once. Reject the start
  // (rather than silently dropping them) so the host can act on it.
  const busy = await findMemberInLiveAuctionMatch(ordered.map((member) => member.user_id));
  if (busy) {
    const busyMember = ordered.find((member) => member.user_id === busy.userId);
    logger.warn(
      { lobbyId, userId: busy.userId, matchId: busy.matchId },
      'Auction lobby start rejected: member already in a live auction match'
    );
    socket.emit('error', {
      code: 'MEMBER_BUSY',
      message: `${busyMember?.nickname ?? 'A player'} is already in an auction match`,
      meta: { userId: busy.userId },
    });
    return;
  }

  const humanPlayers: AuctionMatchHumanPlayer[] = ordered.map((member) => ({
    userId: member.user_id,
    displayName: member.nickname ?? 'Player',
    avatarCustomization: member.avatar_customization ?? null,
  }));

  let matchId: string;
  try {
    const saved = await startAuctionMatchForHumans(io, {
      humanPlayers,
      locale: input.locale ?? 'en',
      // Friendly: marks the match so the finish path awards no Auction Points.
      origin: 'lobby',
      sourceSocket: socket,
    });
    matchId = saved.matchId;

    // The lobby path has no matchmaking `auction:match_found` step, so clients
    // arrive at the auction screen straight from the lobby. Emit the app-wide
    // `auction:state` so each member's global handler populates the auction
    // store before navigating; their follow-up `auction:rejoin` then re-attaches
    // idempotently and resends state.
    const statePayload: AuctionStatePayload = {
      matchId: saved.matchId,
      state: toPublicAuctionMatchState(saved),
      stateVersion: saved.version,
      serverNow: new Date().toISOString(),
    };
    for (const player of humanPlayers) {
      io.to(`user:${player.userId}`).emit('auction:state', statePayload);
    }
  } catch (error) {
    const payload = toAuctionErrorPayload(error, {
      fallbackCode: ErrorCode.AUCTION_CONTENT_UNAVAILABLE,
      fallbackMessage: 'Unable to start the auction match',
    });
    logger.warn({ error, lobbyId, code: payload.code }, 'Auction lobby start failed');
    await lobbiesRepo.setAllReady(lobbyId, false);
    await emitLobbyState(io, lobbyId);
    for (const player of humanPlayers) {
      io.to(`user:${player.userId}`).emit('auction:error', payload);
    }
    return;
  }

  await lobbiesRepo.setLobbyStatus(lobbyId, 'active');
  await emitLobbyState(io, lobbyId);
  await warmupRealtimeService.cleanupLobby(lobbyId);

  logger.info(
    {
      lobbyId,
      matchId,
      humanUserIds: humanPlayers.map((player) => player.userId),
      botCount: AUCTION_SEAT_COUNT - humanPlayers.length,
    },
    'Friendly auction match created from lobby'
  );
}

/**
 * First member (if any) still genuinely seated in a live auction match. Mirrors
 * the matchmaking liveness rule: a finished match, a bot seat, or a forfeited
 * seat is not live participation.
 */
async function findMemberInLiveAuctionMatch(
  userIds: readonly string[]
): Promise<{ userId: string; matchId: string } | null> {
  for (const userId of userIds) {
    const matchId = await auctionStateStore.getActiveMatchIdForUser(userId).catch(() => null);
    if (!matchId) continue;
    const state = await auctionStateStore.load(matchId).catch(() => null);
    if (!state || state.phase === 'finished') continue;
    const seat = findAuctionSeatByUserId(state, userId);
    if (seat && !seat.isBot && !seat.forfeited) {
      return { userId, matchId };
    }
  }
  return null;
}
