import { logger } from '../../core/logger.js';
import { footballersRepo } from './footballers.repo.js';
import { buildUniverse, MATCHER_VERSION, type Universe } from './footballers.universe.js';

export class FootballersError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** A deploy window can need the old release and the new one at once; nothing needs a third. */
const MAX_HELD = 2;
const held = new Map<string, Promise<Universe>>();

async function load(releaseId: string): Promise<Universe> {
  const started = Date.now();
  const release = await footballersRepo.release(releaseId);
  if (!release) throw new FootballersError('wordgame_release_missing');
  // Content names the matcher it was checked with: a different matcher could judge the same text differently.
  if (release.matcher_version !== MATCHER_VERSION) throw new FootballersError('wordgame_release_matcher');
  const players = await footballersRepo.players(releaseId);
  if (players.length !== release.players) throw new FootballersError('wordgame_release_incomplete');
  const universe = buildUniverse(releaseId, players);
  logger.info({ releaseId, players: universe.size, ms: Date.now() - started }, 'Word game release loaded');
  return universe;
}

export const footballersService = {
  /**
   * The footballers of exactly this release, loaded once per process. Never "the newest": a match or a day is judged
   * against the release it names, on every replica. A failed load is not remembered.
   */
  universe(releaseId: string): Promise<Universe> {
    const cached = held.get(releaseId);
    if (cached) {
      // Most recently used last.
      held.delete(releaseId);
      held.set(releaseId, cached);
      return cached;
    }
    const loading = load(releaseId).catch((error) => {
      held.delete(releaseId);
      throw error;
    });
    held.set(releaseId, loading);
    for (const id of held.keys()) {
      if (held.size <= MAX_HELD) break;
      held.delete(id);
    }
    return loading;
  },

  /** Tests only. */
  forget(): void {
    held.clear();
  },
};
