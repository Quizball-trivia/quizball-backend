import { logger } from '../../core/logger.js';
import { withLock } from '../../realtime/locks.js';
import { getRedisClient } from '../../realtime/redis.js';
import type { AuctionMatchState } from './auction-match-state.js';

export const AUCTION_MATCH_STATE_TTL_SECONDS = 2 * 60 * 60;
export const AUCTION_MATCH_LOCK_TTL_MS = 5_000;
export const AUCTION_ACTIVE_MATCHES_KEY = 'auction:matches:active';

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

export interface MutateAuctionMatchStateOptions<T = never> {
  now?: Date | (() => Date);
  onMissingState?: () => T;
}

export type AuctionMatchMutation<T> =
  | AuctionMatchState
  | {
    kind: 'save';
    state: AuctionMatchState;
    map: (saved: AuctionMatchState) => T;
  }
  | {
    kind: 'skip';
    result: T;
  };

export type AuctionMatchStateMutator<T = AuctionMatchState> = (
  state: AuctionMatchState
) => AuctionMatchMutation<T> | Promise<AuctionMatchMutation<T>>;

export function auctionMatchStateKey(matchId: string): string {
  return `auction:match:${matchId}`;
}

export function auctionMatchLockKey(matchId: string): string {
  return `lock:auction:match:${matchId}`;
}

export function auctionUserMatchKey(userId: string): string {
  return `auction:user:${userId}:match`;
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
  if (saved.phase === 'finished') {
    await clearAuctionMatchIndexes(saved);
  } else {
    await indexAuctionMatchState(saved);
  }

  return saved;
}

export function saveAuctionMatchMutation<T>(
  state: AuctionMatchState,
  map: (saved: AuctionMatchState) => T
): Extract<AuctionMatchMutation<T>, { kind: 'save' }> {
  return { kind: 'save', state, map };
}

export function skipAuctionMatchMutation<T>(result: T): Extract<AuctionMatchMutation<T>, { kind: 'skip' }> {
  return { kind: 'skip', result };
}

export async function mutateAuctionMatchState<T = AuctionMatchState>(
  matchId: string,
  mutator: AuctionMatchStateMutator<T>,
  options: MutateAuctionMatchStateOptions<T> = {}
): Promise<T> {
  return withAuctionMatchLock(matchId, async () => {
    const current = await loadAuctionMatchState(matchId);
    if (!current) {
      if (options.onMissingState) return options.onMissingState();
      throw new AuctionMatchStateNotFoundError(matchId);
    }

    const draft = cloneAuctionMatchState(current);
    const mutation = await mutator(draft);

    if (isSkipMutation(mutation)) {
      return mutation.result;
    }

    const mutated = isSaveMutation(mutation) ? mutation.state : mutation;
    const now = resolveMutationNow(options.now);
    const next = {
      ...mutated,
      matchId,
      version: current.version + 1,
      updatedAt: now.toISOString(),
    };

    const saved = await saveAuctionMatchState(next, {
      expectedVersion: current.version,
      now,
    });
    return isSaveMutation(mutation) ? mutation.map(saved) : saved as T;
  });
}

export async function withAuctionMatchLock<T>(
  matchId: string,
  fn: () => Promise<T>
): Promise<T> {
  const lockKey = auctionMatchLockKey(matchId);
  return withLock(lockKey, AUCTION_MATCH_LOCK_TTL_MS, fn, {
    onUnavailable: () => new AuctionMatchLockUnavailableError(matchId),
  });
}

export async function deleteAuctionMatchState(matchId: string): Promise<void> {
  const redis = requireRedis();
  const existing = await loadAuctionMatchState(matchId);
  await redis.del(auctionMatchStateKey(matchId));
  await clearAuctionMatchIndexes(existing ?? matchId);
}

export async function indexAuctionMatchState(state: AuctionMatchState): Promise<void> {
  const redis = requireRedis();
  // Forfeiters are out of the match for good — never (re-)index them as active
  // participants, or a later state save would re-point auction:user:{id}:match
  // at the match they quit and block/steer their next search back into it.
  // (clearAuctionMatchIndexes still clears ALL human ids, forfeited included.)
  const humanUserIds = getHumanUserIds(state, { excludeForfeited: true });
  await redis.sAdd(AUCTION_ACTIVE_MATCHES_KEY, state.matchId);
  await Promise.all(humanUserIds.map((userId) => (
    redis.set(auctionUserMatchKey(userId), state.matchId, {
      EX: AUCTION_MATCH_STATE_TTL_SECONDS,
    })
  )));
}

export async function clearAuctionMatchIndexes(stateOrMatchId: AuctionMatchState | string): Promise<void> {
  const redis = requireRedis();
  const matchId = typeof stateOrMatchId === 'string' ? stateOrMatchId : stateOrMatchId.matchId;
  const state = typeof stateOrMatchId === 'string'
    ? await loadAuctionMatchState(matchId)
    : stateOrMatchId;
  const userKeys = state ? getHumanUserIds(state).map(auctionUserMatchKey) : [];

  await Promise.all([
    redis.sRem(AUCTION_ACTIVE_MATCHES_KEY, matchId),
    userKeys.length > 0 ? redis.del(userKeys) : Promise.resolve(0),
  ]);
}

export async function getActiveAuctionMatchIdForUser(userId: string): Promise<string | null> {
  const redis = requireRedis();
  return redis.get(auctionUserMatchKey(userId));
}

export async function clearAuctionUserMatchIndex(userId: string, expectedMatchId?: string): Promise<void> {
  const redis = requireRedis();
  const key = auctionUserMatchKey(userId);
  if (expectedMatchId) {
    const currentMatchId = await redis.get(key);
    if (currentMatchId !== expectedMatchId) return;
  }
  await redis.del(key);
}

export async function listActiveAuctionMatchIds(): Promise<string[]> {
  const redis = requireRedis();
  return redis.sMembers(AUCTION_ACTIVE_MATCHES_KEY);
}

export const auctionStateStore = {
  load: loadAuctionMatchState,
  save: saveAuctionMatchState,
  mutate: mutateAuctionMatchState,
  withLock: withAuctionMatchLock,
  delete: deleteAuctionMatchState,
  index: indexAuctionMatchState,
  clearIndexes: clearAuctionMatchIndexes,
  getActiveMatchIdForUser: getActiveAuctionMatchIdForUser,
  clearUserMatchIndex: clearAuctionUserMatchIndex,
  listActiveMatchIds: listActiveAuctionMatchIds,
};

function requireRedis() {
  const redis = getRedisClient();
  if (!redis?.isOpen) throw new AuctionStateUnavailableError();
  return redis;
}

function cloneAuctionMatchState(state: AuctionMatchState): AuctionMatchState {
  return JSON.parse(JSON.stringify(state)) as AuctionMatchState;
}

function isSaveMutation<T>(
  mutation: AuctionMatchMutation<T>
): mutation is Extract<AuctionMatchMutation<T>, { kind: 'save' }> {
  return (
    typeof mutation === 'object'
    && mutation !== null
    && 'kind' in mutation
    && mutation.kind === 'save'
  );
}

function isSkipMutation<T>(
  mutation: AuctionMatchMutation<T>
): mutation is Extract<AuctionMatchMutation<T>, { kind: 'skip' }> {
  return (
    typeof mutation === 'object'
    && mutation !== null
    && 'kind' in mutation
    && mutation.kind === 'skip'
  );
}

function resolveMutationNow(now?: Date | (() => Date)): Date {
  return typeof now === 'function' ? now() : now ?? new Date();
}

function getHumanUserIds(
  state: AuctionMatchState,
  options: { excludeForfeited?: boolean } = {}
): string[] {
  return state.seats
    .filter((seat) => !seat.isBot && seat.userId)
    .filter((seat) => !options.excludeForfeited || !seat.forfeited)
    .map((seat) => seat.userId as string);
}
