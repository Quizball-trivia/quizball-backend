import { matchesRepo } from '../modules/matches/matches.repo.js';
import { acquireLock, releaseLock } from './locks.js';
import { getCachedPlayer, getMatchCacheOrRebuild, setMatchCache } from './match-cache.js';
import { HALFTIME_POST_BAN_REVEAL_MS } from './possession-halftime.js';
import {
  emitMatchState,
  fireAndForget,
  getHalftimeTurnSeat,
  scheduleFinalizeHalftime,
  schedulePossessionAiHalftimeBan,
} from './possession-match-flow.js';
import { bumpStateVersion, seatToBanKey } from './possession-state.js';
import type { QuizballServer, QuizballSocket } from './socket-server.js';

export async function handlePossessionHalftimeBan(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: { matchId: string; categoryId: string }
): Promise<void> {
  const lockKey = `lock:match:${payload.matchId}:halftime_ban`;
  const lock = await acquireLock(lockKey, 3000);
  if (!lock.acquired || !lock.token) {
    socket.emit('error', {
      code: 'MATCH_BUSY',
      message: 'Match is busy. Please retry halftime ban.',
    });
    return;
  }

  try {
    const cache = await getMatchCacheOrRebuild(payload.matchId);
    if (!cache || cache.status !== 'active') {
      socket.emit('error', {
        code: 'MATCH_NOT_ACTIVE',
        message: 'No active match found.',
      });
      return;
    }

    const state = cache.statePayload;
    if (state.phase !== 'HALFTIME') {
      socket.emit('error', {
        code: 'MATCH_INVALID_PHASE',
        message: 'Category bans are only allowed during halftime.',
      });
      return;
    }

    const player = getCachedPlayer(cache, socket.data.user.id);
    const seat = player?.seat ?? null;
    if (seat !== 1 && seat !== 2) {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'You are not a participant in this match.',
      });
      return;
    }

    const seatKey = seatToBanKey(seat);
    const otherSeatKey = seatKey === 'seat1' ? 'seat2' : 'seat1';
    const turnSeat = getHalftimeTurnSeat(state);
    if (!turnSeat || seat !== turnSeat) {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'It is not your turn to ban yet.',
      });
      return;
    }
    const validOptionIds = new Set(state.halftime.categoryOptions.map((category) => category.id));
    if (!validOptionIds.has(payload.categoryId)) {
      socket.emit('error', {
        code: 'INVALID_CATEGORY',
        message: 'Selected category is not available for halftime banning.',
      });
      return;
    }

    if (state.halftime.bans[seatKey]) {
      socket.emit('error', {
        code: 'MATCH_ALREADY_BANNED',
        message: 'You already submitted your halftime ban.',
      });
      return;
    }

    if (state.halftime.bans[otherSeatKey] === payload.categoryId) {
      socket.emit('error', {
        code: 'MATCH_INVALID_BAN',
        message: 'That category is already banned by your opponent.',
      });
      return;
    }

    state.halftime.bans[seatKey] = payload.categoryId;
    bumpStateVersion(state);

    await setMatchCache(cache);
    fireAndForget('setMatchStatePayload(halftimeBan)', async () => {
      await matchesRepo.setMatchStatePayload(payload.matchId, state, cache.currentQIndex);
    });
    await emitMatchState(io, payload.matchId, state);

    if (state.halftime.bans.seat1 && state.halftime.bans.seat2) {
      scheduleFinalizeHalftime(io, payload.matchId, HALFTIME_POST_BAN_REVEAL_MS);
    } else {
      schedulePossessionAiHalftimeBan(io, payload.matchId);
    }
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}
