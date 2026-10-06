import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../setup.js';

// A ghost-pairing requeue of a Freecroco player against the reconciler's idle sweep of the same play. Whatever the
// interleaving, a queued search never outlives its play: either the play stays open with its fresh search, or the
// play is returned and nothing is queued for it.

const store = vi.hoisted(() => ({
  entry: { playId: 'play-1', state: 'searching', playState: 'started', updatedAt: 0 },
  redis: new Map<string, Record<string, string>>(),
  userMap: new Map<string, string>(),
  pairing: new Set<string>(),
  /** Runs once, inside the reconciler's state read: where the requeue overtook it. */
  duringReconcilerRead: null as null | (() => Promise<void>),
  locked: new Set<string>(),
}));

vi.mock('../../../../src/db/index.js', () => ({ sql: vi.fn() }));
vi.mock('../../../../src/modules/partners/games/ranked/ranked-entries.js', () => {
  const searching = () => store.entry.state === 'searching';
  return {
    getOpenPartnerRankedEntryForPlay: vi.fn(),
    listPartnerRankedReconcileWork: async () => ({
      endedMatchIds: [],
      blockedInActiveMatch: [],
      staleSearches: [{ userId: 'u1', playId: 'play-1', staleSeconds: 35 }],
    }),
    reconcilePartnerRankedMatch: vi.fn(),
    partnerRankedSearchAge: async (playId: string) =>
      playId === store.entry.playId && searching() ? Math.floor((Date.now() - store.entry.updatedAt) / 1000) : null,
    touchPartnerRankedSearch: async () => {
      if (!searching() || store.entry.playState !== 'started') return null;
      store.entry.updatedAt = Date.now();
      return store.entry.playId;
    },
    releasePartnerRankedSearch: async (_userId: string, _reason: string, playId?: string) => {
      if (!searching() || (playId && playId !== store.entry.playId)) return false;
      store.entry.state = 'cancelled';
      store.entry.playState = 'cancelled';
      return true;
    },
    countPartnerMatchesBetweenToday: vi.fn(),
    partnerDisplayNames: vi.fn(),
    reservePartnerRankedPlay: vi.fn(),
    getOpenPartnerRankedEntry: vi.fn(),
    checkPartnerRankedAdmission: vi.fn(),
    attachPartnerRankedEntriesInTx: vi.fn(),
    settlePartnerRankedMatchSafely: vi.fn(),
    isPartnerMatch: vi.fn(() => false),
    getPartnerRankedResult: vi.fn(),
  };
});
vi.mock('../../../../src/realtime/redis.js', () => {
  const multi = () => {
    const ops: Array<() => void> = [];
    const chain = {
      hSet: (key: string, a: string | Record<string, string>, b?: string) => {
        ops.push(() => {
          if (typeof a === 'string') store.userMap.set(a, b!);
          else store.redis.set(key, { ...a });
        });
        return chain;
      },
      expire: () => chain,
      zAdd: () => chain,
      exec: async () => {
        ops.forEach((op) => op());
        return ops.map(() => 'OK');
      },
    };
    return chain;
  };
  return {
    getRedisClient: () => ({
      isOpen: true,
      multi,
      exists: async (key: string) => (store.pairing.has(key) ? 1 : 0),
      hGet: async (_key: string, userId: string) => store.userMap.get(userId) ?? null,
      hGetAll: async (key: string) => store.redis.get(key) ?? {},
    }),
  };
});
vi.mock('../../../../src/realtime/services/user-session-guard.service.js', () => ({
  SESSION_LOCK_WAIT_MS: 2_000,
  userSessionGuardService: {
    withUserSessionLock: async (userId: string, work: () => Promise<unknown>, options?: { waitMs?: number }) => {
      const deadline = Date.now() + (options?.waitMs ?? 0);
      while (store.locked.has(userId)) {
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      store.locked.add(userId);
      try {
        return await work();
      } finally {
        store.locked.delete(userId);
      }
    },
    resolveStates: async (userIds: string[]) => new Map(userIds.map((u) => [u, { state: 'IDLE', activeMatchId: null }])),
    resolveState: async () => {
      // The queue is empty when read (the pairing took the search); the requeue lands right after.
      const overtake = store.duringReconcilerRead;
      store.duringReconcilerRead = null;
      if (overtake) await overtake();
      return { state: 'IDLE', activeMatchId: null };
    },
    emitState: vi.fn(async () => ({})),
    cleanupRankedQueueArtifacts: vi.fn(),
  },
}));

const { reconcilePartnerRanked } = await import('../../../../src/modules/partners/games/ranked/ranked-realtime.js');
const { __rankedMatchmakingInternals } = await import('../../../../src/realtime/services/ranked-matchmaking.service.js');

const io = {
  in: () => ({ fetchSockets: async () => [] }),
  to: () => ({ emit: vi.fn() }),
} as never;

function queuedSearchForPlay(): Record<string, string> | null {
  const searchId = store.userMap.get('u1');
  const search = searchId ? store.redis.get(`ranked:mm:search:${searchId}`) : undefined;
  return search && search.playId === store.entry.playId ? search : null;
}

describe('partner ghost-pairing requeue vs the reconciler', () => {
  beforeEach(() => {
    store.entry = { playId: 'play-1', state: 'searching', playState: 'started', updatedAt: Date.now() - 35_000 };
    store.redis.clear();
    store.userMap.clear();
    store.pairing.clear();
    store.locked.clear();
  });

  it('a requeue landing during the idle sweep never leaves a queued search on a returned play', async () => {
    let requeue: Promise<void> = Promise.resolve();
    store.duringReconcilerRead = async () => {
      requeue = __rankedMatchmakingInternals.requeueRankedSearch(io, 'u1', 'freecroco-test');
      // Let an unsynchronised requeue run to completion before the sweep goes on.
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await reconcilePartnerRanked(io);
    await requeue;

    const queued = queuedSearchForPlay();
    if (store.entry.state === 'searching') {
      expect(queued).not.toBeNull();
    } else {
      expect(queued).toBeNull();
    }
  });

  it('a requeue after its play ended enqueues nothing', async () => {
    store.entry.playState = 'cancelled';
    await __rankedMatchmakingInternals.requeueRankedSearch(io, 'u1', 'freecroco-test');
    expect(store.userMap.has('u1')).toBe(false);
  });

  it('a fresh queued search for the play stops the idle sweep', async () => {
    store.userMap.set('u1', 's-fresh');
    store.redis.set('ranked:mm:search:s-fresh', { userId: 'u1', playId: 'play-1', queuedAt: String(Date.now()) });
    await reconcilePartnerRanked(io);
    expect(store.entry.state).toBe('searching');
  });
});
