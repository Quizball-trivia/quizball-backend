import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type { WarmupTapInput, WarmupDroppedInput } from '../schemas/warmup.schemas.js';
import { getRedisClient } from '../redis.js';
import { acquireLock, releaseLock } from '../locks.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { warmupRepo } from '../../modules/warmup/warmup.repo.js';
import { logger } from '../../core/logger.js';

const WARMUP_STATE_TTL_SEC = 3600;
const LOCK_TTL_MS = 2000;
const DEDUP_TTL_SEC = 30;
const MIN_DROP_MS = 400;
const SCORE_REQUEST_DEBOUNCE_MS = 1200;
const SCORE_ERROR_THROTTLE_MS = 15000;

const scoreRequestAtBySocket = new Map<string, number>();
const scoreErrorAtByLobby = new Map<string, number>();

interface WarmupRedisState {
  active: boolean;
  bounceCount: number;
  nextTurnUserId: string;
  lastTapperId: string | null;
  memberIds: [string, string];
  startedAt: number;
  lastTapAt: number;
}

function stateKey(lobbyId: string): string {
  return `warmup:state:${lobbyId}`;
}

function lockKey(lobbyId: string): string {
  return `lock:warmup:${lobbyId}`;
}

function dedupKey(lobbyId: string, tapSeq: number): string {
  return `warmup:dedup:${lobbyId}:${tapSeq}`;
}

async function getState(lobbyId: string): Promise<WarmupRedisState | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  const raw = await redis.get(stateKey(lobbyId));
  if (!raw) return null;
  return JSON.parse(raw) as WarmupRedisState;
}

async function saveState(lobbyId: string, state: WarmupRedisState): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  await redis.set(stateKey(lobbyId), JSON.stringify(state), { EX: WARMUP_STATE_TTL_SEC });
}

function shouldLogScoreError(lobbyId: string): boolean {
  const now = Date.now();
  const lastAt = scoreErrorAtByLobby.get(lobbyId) ?? 0;
  if (now - lastAt < SCORE_ERROR_THROTTLE_MS) return false;
  scoreErrorAtByLobby.set(lobbyId, now);
  return true;
}

export const warmupRealtimeService = {
  async handleTap(io: QuizballServer, socket: QuizballSocket, payload: WarmupTapInput): Promise<void> {
    const lobbyId = socket.data.lobbyId;
    const userId = socket.data.user.id;

    if (!lobbyId) {
      socket.emit('error', { code: 'NOT_IN_LOBBY', message: 'You are not in a lobby' });
      return;
    }

    const lock = await acquireLock(lockKey(lobbyId), LOCK_TTL_MS);
    if (!lock.acquired || !lock.token) return;

    try {
      let state = await getState(lobbyId);

      // Lazy init
      if (!state) {
        const members = await lobbiesRepo.listMembersWithUser(lobbyId);
        const lobby = await lobbiesRepo.getById(lobbyId);
        if (!lobby || lobby.status !== 'waiting' || members.length !== 2) {
          return;
        }

        state = {
          active: true,
          bounceCount: 0,
          nextTurnUserId: userId,
          lastTapperId: null,
          memberIds: [members[0].user_id, members[1].user_id],
          startedAt: Date.now(),
          lastTapAt: 0,
        };
      }

      if (!state.active) return;

      if (userId !== state.nextTurnUserId) {
        socket.emit('error', { code: 'NOT_YOUR_TURN', message: 'It is not your turn' });
        return;
      }

      // Dedup check
      const redis = getRedisClient();
      if (redis) {
        const dedupResult = await redis.set(dedupKey(lobbyId, payload.tapSeq), '1', {
          NX: true,
          EX: DEDUP_TTL_SEC,
        });
        if (dedupResult !== 'OK') return;
      }

      state.bounceCount += 1;
      state.lastTapperId = userId;
      state.lastTapAt = Date.now();
      state.nextTurnUserId = state.memberIds[0] === userId ? state.memberIds[1] : state.memberIds[0];

      await saveState(lobbyId, state);

      io.to(`lobby:${lobbyId}`).emit('warmup:tapped', {
        tapperId: userId,
        tapX: payload.tapX,
        tapY: payload.tapY,
        bounceCount: state.bounceCount,
        nextTurnUserId: state.nextTurnUserId,
      });
    } finally {
      await releaseLock(lockKey(lobbyId), lock.token);
    }
  },

  async handleDropped(io: QuizballServer, socket: QuizballSocket, _payload: WarmupDroppedInput): Promise<void> {
    const lobbyId = socket.data.lobbyId;
    if (!lobbyId) return;

    const lock = await acquireLock(lockKey(lobbyId), LOCK_TTL_MS);
    if (!lock.acquired || !lock.token) return;

    try {
      const state = await getState(lobbyId);
      if (!state || !state.active) return;

      // Drop guard: ignore if too soon after last tap
      if (Date.now() - state.lastTapAt < MIN_DROP_MS) return;

      state.active = false;
      await saveState(lobbyId, state);

      let scoreResult;
      try {
        scoreResult = await warmupRepo.saveScore(state.memberIds, state.bounceCount);
      } catch (error) {
        logger.warn({ error, lobbyId, score: state.bounceCount }, 'Failed to save warmup score');
        scoreResult = {
          playerBests: Object.fromEntries(state.memberIds.map((id) => [id, state.bounceCount])),
          pairBest: state.bounceCount,
          isNewPlayerBest: Object.fromEntries(state.memberIds.map((id) => [id, false])),
          isNewPairBest: false,
        };
      }

      io.to(`lobby:${lobbyId}`).emit('warmup:over', {
        finalScore: state.bounceCount,
        playerBests: scoreResult.playerBests,
        pairBest: scoreResult.pairBest,
        isNewPlayerBest: scoreResult.isNewPlayerBest,
        isNewPairBest: scoreResult.isNewPairBest,
      });

      // Clean up state key
      const redis = getRedisClient();
      if (redis) {
        await redis.del(stateKey(lobbyId));
      }
    } finally {
      await releaseLock(lockKey(lobbyId), lock.token);
    }
  },

  async handleRestart(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const lobbyId = socket.data.lobbyId;
    if (!lobbyId) return;

    const lock = await acquireLock(lockKey(lobbyId), LOCK_TTL_MS);
    if (!lock.acquired || !lock.token) return;

    try {
      const members = await lobbiesRepo.listMembersWithUser(lobbyId);
      const lobby = await lobbiesRepo.getById(lobbyId);
      if (!lobby || lobby.status !== 'waiting' || members.length !== 2) return;

      const memberIds: [string, string] = [members[0].user_id, members[1].user_id];
      const firstTurnUserId = memberIds[Math.floor(Math.random() * 2)];

      const state: WarmupRedisState = {
        active: true,
        bounceCount: 0,
        nextTurnUserId: firstTurnUserId,
        lastTapperId: null,
        memberIds,
        startedAt: Date.now(),
        lastTapAt: 0,
      };

      await saveState(lobbyId, state);

      io.to(`lobby:${lobbyId}`).emit('warmup:restarted', { firstTurnUserId });
      io.to(`lobby:${lobbyId}`).emit('warmup:state', {
        active: true,
        bounceCount: 0,
        nextTurnUserId: firstTurnUserId,
        lastTapperId: null,
        startedAt: state.startedAt,
      });
    } finally {
      await releaseLock(lockKey(lobbyId), lock.token);
    }
  },

  async handleGetScores(_io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const lobbyId = socket.data.lobbyId;
    const userId = socket.data.user.id;
    if (!lobbyId) return;

    const debounceKey = `${socket.id}:${lobbyId}`;
    const now = Date.now();
    const lastRequestAt = scoreRequestAtBySocket.get(debounceKey) ?? 0;
    if (now - lastRequestAt < SCORE_REQUEST_DEBOUNCE_MS) {
      return;
    }
    scoreRequestAtBySocket.set(debounceKey, now);

    try {
      const members = await lobbiesRepo.listMembersWithUser(lobbyId);
      if (members.length !== 2) {
        socket.emit('warmup:scores', { playerBest: 0, pairBest: 0 });
        return;
      }

      const otherUserId = members.find((m) => m.user_id !== userId)?.user_id;
      if (!otherUserId) {
        socket.emit('warmup:scores', { playerBest: 0, pairBest: 0 });
        return;
      }

      const [playerBest, pairBest] = await Promise.all([
        warmupRepo.getPlayerBest(userId),
        warmupRepo.getPairBest(userId, otherUserId),
      ]);

      socket.emit('warmup:scores', {
        playerBest: playerBest?.best_score ?? 0,
        pairBest: pairBest?.best_score ?? 0,
      });
    } catch (error) {
      if (shouldLogScoreError(lobbyId)) {
        logger.warn({ error, lobbyId, userId }, 'Failed to get warmup scores');
      }
      socket.emit('warmup:scores', { playerBest: 0, pairBest: 0 });
    }
  },

  async cleanupLobby(lobbyId: string): Promise<void> {
    try {
      const redis = getRedisClient();
      if (redis) {
        await redis.del(stateKey(lobbyId));
      }
      scoreErrorAtByLobby.delete(lobbyId);
      logger.info({ lobbyId }, 'Warmup state cleaned up');
    } catch (error) {
      logger.warn({ error, lobbyId }, 'Warmup cleanup failed');
    }
  },
};
