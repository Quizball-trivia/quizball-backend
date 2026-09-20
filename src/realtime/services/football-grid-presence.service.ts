import { randomUUID } from 'node:crypto';
import { footballGridRepo } from '../../modules/football-grid/index.js';
import { acquireLock, releaseLock, startLockHeartbeat } from '../locks.js';
import { getRedisClient } from '../redis.js';
import { scheduleRealtimeTimer } from '../realtime-timer-scheduler.js';

const TIMER_KIND = 'football_grid_presence_expiry' as const;
const LEASE_MS = 15_000;
const KEY_TTL_SEC = 45;
const NODE_HEARTBEAT_MS = 5_000;
const NODE_TTL_SEC = 20;
const LEASE_LOCK_TTL_MS = 10_000;
const LEASE_LOCK_WAIT_MS = 750;
const NODE_ID = `${process.env.RAILWAY_REPLICA_ID ?? process.env.HOSTNAME ?? 'local'}:${process.pid}:${randomUUID()}`;
let nodeHeartbeatTimer: NodeJS.Timeout | null = null;

interface SocketLease {
  expiresAt: number;
  nodeId: string | null;
  generation: number | null;
}

function key(matchId: string, userId: string): string {
  return `football_grid:presence:${matchId}:${userId}`;
}

function lockKey(matchId: string, userId: string): string {
  return `lock:football_grid:presence:${matchId}:${userId}`;
}

function nodeKey(nodeId: string): string {
  return `football_grid:node:${nodeId}`;
}

function parseLease(raw: string): SocketLease | null {
  const legacyExpiry = Number(raw);
  if (Number.isFinite(legacyExpiry)) return { expiresAt: legacyExpiry, nodeId: null, generation: null };
  try {
    const value = JSON.parse(raw) as Partial<SocketLease>;
    if (!Number.isFinite(value.expiresAt)) return null;
    return {
      expiresAt: Number(value.expiresAt),
      nodeId: typeof value.nodeId === 'string' ? value.nodeId : null,
      generation: Number.isFinite(value.generation) ? Number(value.generation) : null,
    };
  } catch {
    return null;
  }
}

async function refreshNodeHeartbeat(): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  await redis.set(nodeKey(NODE_ID), String(Date.now()), { EX: NODE_TTL_SEC });
}

function ensureNodeHeartbeat(): void {
  if (nodeHeartbeatTimer) return;
  void refreshNodeHeartbeat().catch(() => {});
  nodeHeartbeatTimer = setInterval(() => void refreshNodeHeartbeat().catch(() => {}), NODE_HEARTBEAT_MS);
  nodeHeartbeatTimer.unref?.();
}

async function schedule(matchId: string, userId: string, generation: number, dueAt: number): Promise<void> {
  await scheduleRealtimeTimer(
    TIMER_KIND,
    `${matchId}:${userId}`,
    new Date(dueAt),
    { kind: TIMER_KIND, matchId, userId, expectedPresenceGeneration: generation },
  );
}

async function withLeaseLock<T>(matchId: string, userId: string, work: () => Promise<T>): Promise<T | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= LEASE_LOCK_WAIT_MS) {
    const lock = await acquireLock(lockKey(matchId, userId), LEASE_LOCK_TTL_MS);
    if (lock.acquired && lock.token) {
      const heartbeat = startLockHeartbeat(lockKey(matchId, userId), lock.token, LEASE_LOCK_TTL_MS);
      try {
        return await work();
      } finally {
        heartbeat.stop();
        await releaseLock(lockKey(matchId, userId), lock.token).catch(() => {});
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function liveLeaseCount(matchId: string, userId: string): Promise<{
  count: number;
  nextExpiry: number | null;
}> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return { count: 0, nextExpiry: null };
  const values = await redis.hGetAll(key(matchId, userId));
  const now = Date.now();
  const parsed = Object.entries(values).map(([socketId, raw]) => ({ socketId, lease: parseLease(raw) }));
  const nodeIds = [...new Set(parsed
    .map((entry) => entry.lease?.nodeId)
    .filter((nodeId): nodeId is string => Boolean(nodeId)))];
  const nodeHeartbeats = nodeIds.length > 0 ? await redis.mGet(nodeIds.map(nodeKey)) : [];
  const liveNodes = new Set(nodeIds.filter((_, index) => nodeHeartbeats[index] !== null));
  const expiredSocketIds: string[] = [];
  const live: SocketLease[] = [];
  for (const entry of parsed) {
    const lease = entry.lease;
    const nodeIsLive = lease?.nodeId === null || (lease?.nodeId ? liveNodes.has(lease.nodeId) : false);
    if (!lease || lease.expiresAt <= now || !nodeIsLive) expiredSocketIds.push(entry.socketId);
    else live.push(lease);
  }
  if (expiredSocketIds.length > 0) await redis.hDel(key(matchId, userId), expiredSocketIds);
  return {
    count: live.length,
    // Absence begins only after the final live socket lease expires.
    nextExpiry: live.length > 0 ? Math.max(...live.map((lease) => lease.expiresAt)) : null,
  };
}

export type FootballGridPresenceReconciliation<T> =
  | { status: 'present' | 'stale'; value: null }
  | { status: 'absent'; value: T; generation: number }
  | { status: 'indeterminate'; value: null };

export const footballGridPresenceService = {
  startNodeHeartbeat(): void {
    ensureNodeHeartbeat();
  },

  async touch(matchId: string, userId: string, socketId: string): Promise<void> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    ensureNodeHeartbeat();
    const generation = await footballGridRepo.getPresenceGeneration(matchId, userId);
    if (generation === null) throw new Error('NOT_PARTICIPANT');
    const expiresAt = Date.now() + LEASE_MS;
    const changed = await withLeaseLock(matchId, userId, async () => {
      await refreshNodeHeartbeat();
      await redis.multi()
        .hSet(key(matchId, userId), socketId, JSON.stringify({ expiresAt, nodeId: NODE_ID, generation }))
        .expire(key(matchId, userId), KEY_TTL_SEC)
        .exec();
      return true;
    });
    if (!changed) throw new Error('GRID_PRESENCE_BUSY');
    await schedule(matchId, userId, generation, expiresAt);
  },

  async refresh(matchId: string, userId: string, socketId: string): Promise<boolean> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return false;
    ensureNodeHeartbeat();
    const expiresAt = Date.now() + LEASE_MS;
    const generation = await withLeaseLock(matchId, userId, async () => {
      const existing = parseLease(await redis.hGet(key(matchId, userId), socketId) ?? '');
      if (existing?.generation === null || existing?.generation === undefined) return null;
      await redis.multi()
        .hSet(key(matchId, userId), socketId, JSON.stringify({
          expiresAt,
          nodeId: NODE_ID,
          generation: existing.generation,
        }))
        .expire(key(matchId, userId), KEY_TTL_SEC)
        .exec();
      return existing.generation;
    });
    if (generation === null) return false;
    await schedule(matchId, userId, generation, expiresAt);
    return true;
  },

  async detach(matchId: string, userId: string, socketId: string): Promise<void> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    await withLeaseLock(matchId, userId, async () => {
      await redis.hDel(key(matchId, userId), socketId);
      const live = await liveLeaseCount(matchId, userId);
      if (live.count > 0) return;
      const generation = await footballGridRepo.getPresenceGeneration(matchId, userId);
      if (generation !== null) await schedule(matchId, userId, generation, Date.now());
    });
  },

  async reconcile<T>(
    matchId: string,
    userId: string,
    expectedGeneration: number | null,
    onAbsent: (generation: number) => Promise<T>,
  ): Promise<FootballGridPresenceReconciliation<T>> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return { status: 'indeterminate', value: null };
    const result = await withLeaseLock(matchId, userId, async (): Promise<FootballGridPresenceReconciliation<T>> => {
      const live = await liveLeaseCount(matchId, userId);
      const generation = await footballGridRepo.getPresenceGeneration(matchId, userId);
      if (generation === null || (expectedGeneration !== null && generation !== expectedGeneration)) {
        return { status: 'stale', value: null };
      }
      if (live.count > 0) {
        if (live.nextExpiry) await schedule(matchId, userId, generation, live.nextExpiry);
        return { status: 'present', value: null };
      }
      // touch/detach use this same fence, so a heartbeat cannot land between
      // the last live-lease check and the authoritative DB absence commit.
      return { status: 'absent', value: await onAbsent(generation), generation };
    });
    return result ?? { status: 'indeterminate', value: null };
  },
};
