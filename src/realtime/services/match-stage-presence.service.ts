import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import {
  matchStagePresenceKey,
  matchStageReadyKey,
} from '../match-keys.js';
import { getRedisClient } from '../redis.js';

const STAGE_PRESENCE_TTL_SEC = 8;
const STAGE_READY_TTL_SEC = 45;
const DEFAULT_READY_POLL_MS = 100;

export type MatchStageKey =
  | 'penalties'
  | 'kickoff'
  | 'draft_ban'
  | 'category_ban'
  | 'halftime'
  | 'resume'
  | 'party_quiz'
  | 'question';

export type MatchStageReadyResult = {
  readyUserIds: string[];
  missingUserIds: string[];
  reason: 'all_ready' | 'timeout' | 'redis_unavailable';
};

export function isMatchStagePresenceEnabled(): boolean {
  return config.MATCH_STAGE_PRESENCE_ENABLED;
}

export function normalizeMatchStageKey(stageKey: string | null | undefined): string | null {
  const normalized = stageKey?.trim().replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 64);
  return normalized && normalized.length > 0 ? normalized : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function recordMatchStagePresenceHeartbeat(params: {
  matchId: string;
  userId: string;
  stageKey: string;
}): Promise<boolean> {
  const stageKey = normalizeMatchStageKey(params.stageKey);
  if (!stageKey) return false;
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  await redis.set(matchStagePresenceKey(params.matchId, stageKey, params.userId), String(Date.now()), {
    EX: STAGE_PRESENCE_TTL_SEC,
  });
  return true;
}

export async function recordMatchStageReady(params: {
  matchId: string;
  userId: string;
  stageKey: string;
}): Promise<boolean> {
  const stageKey = normalizeMatchStageKey(params.stageKey);
  if (!stageKey) return false;
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  await redis.set(matchStageReadyKey(params.matchId, stageKey, params.userId), String(Date.now()), {
    EX: STAGE_READY_TTL_SEC,
  });
  return true;
}

export async function hasMatchStagePresence(params: {
  matchId: string;
  userId: string;
  stageKey: string;
}): Promise<boolean> {
  const stageKey = normalizeMatchStageKey(params.stageKey);
  if (!stageKey) return false;
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  return (await redis.exists(matchStagePresenceKey(params.matchId, stageKey, params.userId))) === 1;
}

export async function waitForMatchStageReady(params: {
  matchId: string;
  userIds: string[];
  stageKey: string;
  ceilingMs: number;
  pollMs?: number;
}): Promise<MatchStageReadyResult> {
  const stageKey = normalizeMatchStageKey(params.stageKey);
  const userIds = [...new Set(params.userIds.filter(Boolean))];
  if (!stageKey || userIds.length === 0) {
    return { readyUserIds: [], missingUserIds: userIds, reason: 'timeout' };
  }

  const redis = getRedisClient();
  if (!redis?.isOpen) {
    return { readyUserIds: [], missingUserIds: userIds, reason: 'redis_unavailable' };
  }

  const deadlineMs = Date.now() + Math.max(0, params.ceilingMs);
  const pollMs = Math.max(20, params.pollMs ?? DEFAULT_READY_POLL_MS);

  while (Date.now() <= deadlineMs) {
    const readyResults = await Promise.all(
      userIds.map((userId) => redis.exists(matchStageReadyKey(params.matchId, stageKey, userId)))
    );
    const readyUserIds = userIds.filter((_, index) => readyResults[index] === 1);
    if (readyUserIds.length === userIds.length) {
      return { readyUserIds, missingUserIds: [], reason: 'all_ready' };
    }

    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollMs, remainingMs));
  }

  const finalReadyResults = await Promise.all(
    userIds.map((userId) => redis.exists(matchStageReadyKey(params.matchId, stageKey, userId)))
  );
  const readyUserIds = userIds.filter((_, index) => finalReadyResults[index] === 1);
  const missingUserIds = userIds.filter((userId) => !readyUserIds.includes(userId));
  if (missingUserIds.length > 0) {
    logger.info(
      { matchId: params.matchId, stageKey, missingUserIds },
      'Match stage ready wait reached ceiling'
    );
  }
  return { readyUserIds, missingUserIds, reason: missingUserIds.length === 0 ? 'all_ready' : 'timeout' };
}
