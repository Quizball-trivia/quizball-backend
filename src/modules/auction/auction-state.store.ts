import { logger } from '../../core/logger.js';
import { acquireLock, releaseLock } from '../../realtime/locks.js';
import { getRedisClient } from '../../realtime/redis.js';
import type { AuctionMatchState } from './auction-match-state.js';

export const AUCTION_MATCH_STATE_TTL_SECONDS = 2 * 60 * 60;
export const AUCTION_MATCH_LOCK_TTL_MS = 5_000;

export class AuctionStateStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class AuctionStateUnavailableError extends AuctionStateStoreError {
  constructor() {
    super('Redis is unavailable for auction match state');
  }
}

export class AuctionMatchStateNotFoundError extends AuctionStateStoreError {
  constructor(matchId: string) {
    super(`Auction match state not found: ${matchId}`);
  }
}

export class AuctionMatchStateStaleError extends AuctionStateStoreError {
  constructor(matchId: string, expectedVersion: number, actualVersion: number | null) {
    super(`Auction match state stale: ${matchId} expected version ${expectedVersion}, got ${actualVersion ?? 'missing'}`);
  }
}

export class AuctionMatchLockUnavailableError extends AuctionStateStoreError {
  constructor(matchId: string) {
    super(`Auction match lock unavailable: ${matchId}`);
  }
}

export interface SaveAuctionMatchStateOptions {
  expectedVersion?: number;
  now?: Date;
}

export interface MutateAuctionMatchStateOptions {
  now?: Date;
}

export type AuctionMatchStateMutator = (
  state: AuctionMatchState
) => AuctionMatchState | Promise<AuctionMatchState>;

export function auctionMatchStateKey(matchId: string): string {
  return `auction:match:${matchId}`;
}

export function auctionMatchLockKey(matchId: string): string {
  return `lock:auction:match:${matchId}`;
}

export async function loadAuctionMatchState(matchId: string): Promise<AuctionMatchState | null> {
  const redis = requireRedis();
  const raw = await redis.get(auctionMatchStateKey(matchId));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as AuctionMatchState;
  } catch (error) {
    logger.error({ error, matchId }, 'Failed to parse auction match state');
    return null;
  }
}

export async function saveAuctionMatchState(
  state: AuctionMatchState,
  options: SaveAuctionMatchStateOptions = {}
): Promise<AuctionMatchState> {
  const redis = requireRedis();

  if (options.expectedVersion !== undefined) {
    const existing = await loadAuctionMatchState(state.matchId);
    const actualVersion = existing?.version ?? null;
    if (actualVersion !== options.expectedVersion) {
      throw new AuctionMatchStateStaleError(state.matchId, options.expectedVersion, actualVersion);
    }
  }

  const saved = {
    ...state,
    updatedAt: (options.now ?? new Date()).toISOString(),
  };

  await redis.set(auctionMatchStateKey(saved.matchId), JSON.stringify(saved), {
    EX: AUCTION_MATCH_STATE_TTL_SECONDS,
  });

  return saved;
}

export async function mutateAuctionMatchState(
  matchId: string,
  mutator: AuctionMatchStateMutator,
  options: MutateAuctionMatchStateOptions = {}
): Promise<AuctionMatchState> {
  const lockKey = auctionMatchLockKey(matchId);
  const lock = await acquireLock(lockKey, AUCTION_MATCH_LOCK_TTL_MS);
  if (!lock.acquired || !lock.token) {
    throw new AuctionMatchLockUnavailableError(matchId);
  }

  try {
    const current = await loadAuctionMatchState(matchId);
    if (!current) throw new AuctionMatchStateNotFoundError(matchId);

    const draft = cloneAuctionMatchState(current);
    const mutated = await mutator(draft);
    const next = {
      ...mutated,
      matchId,
      version: current.version + 1,
      updatedAt: (options.now ?? new Date()).toISOString(),
    };

    return saveAuctionMatchState(next, { now: options.now });
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}

export async function withAuctionMatchLock<T>(
  matchId: string,
  fn: () => Promise<T>
): Promise<T> {
  const lockKey = auctionMatchLockKey(matchId);
  const lock = await acquireLock(lockKey, AUCTION_MATCH_LOCK_TTL_MS);
  if (!lock.acquired || !lock.token) {
    throw new AuctionMatchLockUnavailableError(matchId);
  }

  try {
    return await fn();
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}

export async function deleteAuctionMatchState(matchId: string): Promise<void> {
  const redis = requireRedis();
  await redis.del(auctionMatchStateKey(matchId));
}

export const auctionStateStore = {
  load: loadAuctionMatchState,
  save: saveAuctionMatchState,
  mutate: mutateAuctionMatchState,
  withLock: withAuctionMatchLock,
  delete: deleteAuctionMatchState,
};

function requireRedis() {
  const redis = getRedisClient();
  if (!redis?.isOpen) throw new AuctionStateUnavailableError();
  return redis;
}

function cloneAuctionMatchState(state: AuctionMatchState): AuctionMatchState {
  return JSON.parse(JSON.stringify(state)) as AuctionMatchState;
}
