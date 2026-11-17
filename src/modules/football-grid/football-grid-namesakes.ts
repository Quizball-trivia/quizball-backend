import { logger } from '../../core/logger.js';
import {
  footballGridAddNames,
  normalizeFootballGridAnswer,
  type FootballGridNameIndex,
  type FootballGridNameUniverse,
} from './football-grid.answer-resolver.js';
import { footballGridRepo } from './football-grid.repo.js';

const PAGE = 20_000;
const REFRESH_MS = 6 * 60 * 60_000;
const RETRY_MS = 5 * 60_000;

let index: FootballGridNameIndex | null = null;
let loadedAt = 0;
let loading: Promise<void> | null = null;
let failedAt = 0;

async function load(): Promise<void> {
  const started = Date.now();
  const next: FootballGridNameIndex = new Map();
  let after: string | null = null;
  for (;;) {
    const page = await footballGridRepo.getFootballerNamesPage(after, PAGE);
    // Page by page, so the build never holds every row at once or blocks the event loop for long.
    footballGridAddNames(next, page.map((row) => ({ playerId: row.id, normalized: normalizeFootballGridAnswer(row.name) })));
    if (page.length < PAGE) break;
    after = page[page.length - 1].id;
  }
  index = next;
  loadedAt = Date.now();
  logger.info({ names: next.size, ms: loadedAt - started }, 'Football Grid namesake index loaded');
}

/**
 * Every footballer's name (not just the ones a Grid release knows), for the typo veto: a sibling's name one letter from
 * the answer is not a slip for it even on a board whose release has never heard of the sibling. Loaded once per process in the
 * background and refreshed every few hours; until the first load lands the Grid releases alone are read, so an
 * answer never waits on it.
 */
function refreshIfDue(): void {
  const now = Date.now();
  if (!loading && now - loadedAt > REFRESH_MS && now - failedAt > RETRY_MS) {
    loading = load()
      .catch((error) => {
        failedAt = Date.now();
        logger.warn({ err: error }, 'Football Grid namesake index could not be loaded');
      })
      .finally(() => { loading = null; });
  }
}

export const footballGridNamesakes: FootballGridNameUniverse = {
  holders(matchKey) {
    refreshIfDue();
    return index?.get(matchKey) ?? [];
  },
};

/** Starts the first load at boot, so the window in which only the Grid releases are read is the load's few seconds. */
export function warmFootballGridNamesakes(): void {
  refreshIfDue();
}
