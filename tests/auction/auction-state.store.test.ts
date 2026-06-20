import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

import { createEmptyTeam } from '../../src/modules/auction/auction-rules.js';
import type {
  AuctionFootballer,
  AuctionPlayer,
} from '../../src/modules/auction/auction.types.js';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';

type RedisSetOptions = { EX?: number; PX?: number; NX?: boolean };

class FakeRedis {
  isOpen = true;
  values = new Map<string, string>();
  expirations = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<'OK' | null> {
    if (options?.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    if (options?.EX) this.expirations.set(key, options.EX);
    if (options?.PX) this.expirations.set(key, options.PX);
    return 'OK';
  }

  async del(keyOrKeys: string | string[]): Promise<number> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    let removed = 0;
    for (const key of keys) {
      if (this.values.delete(key)) removed += 1;
      this.expirations.delete(key);
    }
    return removed;
  }

  async eval(_script: string, params: { keys: string[]; arguments: string[] }): Promise<unknown> {
    const [key] = params.keys;
    const [token] = params.arguments;
    if (this.values.get(key) !== token) return 0;
    this.values.delete(key);
    this.expirations.delete(key);
    return 1;
  }
}

let redis: FakeRedis | null;

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redis,
}));

const footballer = {
  id: 'footballer-1',
  clueCardId: '11111111-1111-1111-1111-111111111111',
  name: 'Erling Haaland',
  positionGroup: 'FWD',
  trueValue: 180_000_000,
  startingPrice: 30_000_000,
  clues: [
    'Scored heavily in his first Premier League campaign.',
    'Won the Champions League with a Manchester club.',
    'Represents Norway at international level.',
  ],
  imageUrl: 'https://img.example/haaland.jpg',
  currentClub: 'Manchester City',
  nationality: 'Norway',
} satisfies AuctionFootballer;

function seat(seatId: string, userId: string | null, isBot = false): AuctionPlayer {
  return {
    seatId,
    userId,
    displayName: isBot ? `Bot ${seatId}` : `User ${seatId}`,
    isBot,
    budget: 1_000_000_000,
    team: createEmptyTeam('4-3-3'),
    isEliminated: false,
  };
}

function matchState(overrides: Partial<AuctionMatchState> = {}): AuctionMatchState {
  return {
    matchId: 'match-1',
    version: 0,
    phase: 'clue_reveal',
    formation: '4-3-3',
    seats: [
      seat('seat-human', 'user-1'),
      seat('seat-bot-a', null, true),
      seat('seat-bot-b', null, true),
    ],
    currentRound: {
      roundId: 'round-1',
      roundIndex: 1,
      positionGroup: 'FWD',
      footballer,
      clueRevealIndex: 1,
      bids: [],
      highestBidderSeatId: null,
      highestBid: 0,
      startingPrice: footballer.startingPrice,
      winnerSeatId: null,
      winningBid: 0,
      revealed: false,
      turnOrder: ['seat-human', 'seat-bot-a', 'seat-bot-b'],
      currentTurnSeatId: null,
      foldedSeatIds: [],
      turnEndsAt: null,
      startedAt: '2026-06-20T10:00:00.000Z',
      updatedAt: '2026-06-20T10:00:00.000Z',
    },
    completedRounds: [],
    soloPick: null,
    usedClueCardIds: [footballer.clueCardId],
    rankings: null,
    createdAt: '2026-06-20T10:00:00.000Z',
    updatedAt: '2026-06-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('auction state store', () => {
  beforeEach(() => {
    redis = new FakeRedis();
  });

  it('saves and loads auction match state with the expected TTL', async () => {
    const {
      AUCTION_MATCH_STATE_TTL_SECONDS,
      auctionMatchStateKey,
      auctionStateStore,
    } = await import('../../src/modules/auction/auction-state.store.js');
    const state = matchState();

    const saved = await auctionStateStore.save(state, {
      now: new Date('2026-06-20T10:05:00.000Z'),
    });
    const loaded = await auctionStateStore.load(state.matchId);

    expect(saved.updatedAt).toBe('2026-06-20T10:05:00.000Z');
    expect(loaded).toEqual(saved);
    expect(redis?.expirations.get(auctionMatchStateKey(state.matchId))).toBe(AUCTION_MATCH_STATE_TTL_SECONDS);
  });

  it('returns null for missing match state', async () => {
    const { auctionStateStore } = await import('../../src/modules/auction/auction-state.store.js');

    await expect(auctionStateStore.load('missing-match')).resolves.toBeNull();
  });

  it('fails clearly when Redis is unavailable', async () => {
    redis = null;
    const {
      AuctionStateUnavailableError,
      auctionStateStore,
    } = await import('../../src/modules/auction/auction-state.store.js');

    await expect(auctionStateStore.load('match-1')).rejects.toBeInstanceOf(AuctionStateUnavailableError);
  });

  it('rejects stale versioned writes', async () => {
    const {
      AuctionMatchStateStaleError,
      auctionStateStore,
    } = await import('../../src/modules/auction/auction-state.store.js');
    const state = await auctionStateStore.save(matchState({ version: 2 }));

    await expect(
      auctionStateStore.save({ ...state, phase: 'bidding' }, { expectedVersion: 1 })
    ).rejects.toBeInstanceOf(AuctionMatchStateStaleError);
  });

  it('mutates state under a Redis lock and increments version', async () => {
    const {
      AUCTION_MATCH_LOCK_TTL_MS,
      auctionMatchLockKey,
      auctionStateStore,
    } = await import('../../src/modules/auction/auction-state.store.js');
    await auctionStateStore.save(matchState({ version: 4 }));

    const next = await auctionStateStore.mutate(
      'match-1',
      (current) => ({ ...current, phase: 'bidding' }),
      { now: new Date('2026-06-20T10:06:00.000Z') }
    );

    expect(next.phase).toBe('bidding');
    expect(next.version).toBe(5);
    expect(next.updatedAt).toBe('2026-06-20T10:06:00.000Z');
    expect(redis?.values.has(auctionMatchLockKey('match-1'))).toBe(false);
    expect(redis?.expirations.get(auctionMatchLockKey('match-1'))).toBeUndefined();
    expect(AUCTION_MATCH_LOCK_TTL_MS).toBe(5_000);
  });

  it('rejects concurrent mutations while the match lock is held', async () => {
    const {
      AuctionMatchLockUnavailableError,
      auctionStateStore,
    } = await import('../../src/modules/auction/auction-state.store.js');
    await auctionStateStore.save(matchState());

    let releaseMutator!: () => void;
    const firstMutation = auctionStateStore.mutate('match-1', async (current) => {
      await new Promise<void>((resolve) => {
        releaseMutator = resolve;
      });
      return { ...current, phase: 'bidding' };
    });

    await Promise.resolve();

    await expect(
      auctionStateStore.mutate('match-1', (current) => ({ ...current, phase: 'reveal' }))
    ).rejects.toBeInstanceOf(AuctionMatchLockUnavailableError);

    releaseMutator();
    await expect(firstMutation).resolves.toMatchObject({ phase: 'bidding', version: 1 });
  });

  it('supports seat lookup by user id and bot seat id', async () => {
    const {
      findAuctionSeatBySeatId,
      findAuctionSeatByUserId,
    } = await import('../../src/modules/auction/auction-match-state.js');
    const state = matchState();

    expect(findAuctionSeatByUserId(state, 'user-1')?.seatId).toBe('seat-human');
    expect(findAuctionSeatBySeatId(state, 'seat-bot-a')?.isBot).toBe(true);
    expect(findAuctionSeatByUserId(state, 'missing')).toBeNull();
  });

  it('stores full server-side footballer data but hides identity before reveal', async () => {
    const {
      auctionStateStore,
    } = await import('../../src/modules/auction/auction-state.store.js');
    const {
      toPublicAuctionMatchState,
    } = await import('../../src/modules/auction/auction-match-state.js');

    const loaded = await auctionStateStore.save(matchState());
    expect(loaded.currentRound?.footballer.name).toBe('Erling Haaland');
    expect(loaded.currentRound?.footballer.trueValue).toBe(180_000_000);

    const publicState = toPublicAuctionMatchState(loaded);
    const publicFootballer = publicState.currentRound?.footballer;

    expect(publicState.currentRound?.revealedClues).toEqual([footballer.clues[0]]);
    expect(publicFootballer).toEqual({
      positionGroup: 'FWD',
      startingPrice: 30_000_000,
      clues: [footballer.clues[0]],
    });
    expect(JSON.stringify(publicFootballer)).not.toContain('Erling Haaland');
    expect(JSON.stringify(publicFootballer)).not.toContain('180000000');
    expect(JSON.stringify(publicFootballer)).not.toContain('Manchester City');
  });

  it('reveals footballer identity after the round is marked revealed', async () => {
    const {
      toPublicAuctionMatchState,
    } = await import('../../src/modules/auction/auction-match-state.js');
    const state = matchState({
      phase: 'reveal',
      currentRound: {
        ...matchState().currentRound!,
        clueRevealIndex: 3,
        revealed: true,
      },
    });

    const publicState = toPublicAuctionMatchState(state);

    expect(publicState.currentRound?.footballer).toMatchObject({
      id: 'footballer-1',
      clueCardId: '11111111-1111-1111-1111-111111111111',
      name: 'Erling Haaland',
      trueValue: 180_000_000,
      imageUrl: 'https://img.example/haaland.jpg',
      currentClub: 'Manchester City',
      nationality: 'Norway',
    });
  });
});
