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
/** Before the first load lands a failed one is tried again sooner: from this, doubling up to RETRY_MS. */
const FIRST_RETRY_MS = 5_000;
/** Typos are held back for at most this long: a load that never settles must not switch them off for good. */
const GATE_MS = 120_000;

let index: FootballGridNameIndex | null = null;
let loadedAt = 0;
let loading: Promise<void> | null = null;
let failedAt = 0;
let failures = 0;
let warmedAt = 0;

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
 * background and refreshed every few hours; an answer never waits on it (see warmFootballGridNamesakes).
 */
const retryMs = (): number => (index ? RETRY_MS : Math.min(RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1)));

function refreshIfDue(): void {
  const now = Date.now();
  if (!loading && now - loadedAt > REFRESH_MS && now - failedAt > retryMs()) {
    loading = load()
      .then(() => { failures = 0; })
      .catch((error) => {
        failedAt = Date.now();
        failures += 1;
        logger.warn({ err: error }, 'Football Grid namesake index could not be loaded');
        // Until a first load lands typos are off: try again without waiting for the next answer.
        if (!index && warmedAt) setTimeout(refreshIfDue, retryMs() + 50).unref();
      })
      .finally(() => { loading = null; });
  }
}

export const footballGridNamesakes: FootballGridNameUniverse = {
  holders(matchKey) {
    refreshIfDue();
    return index?.get(matchKey) ?? [];
  },
  // Only a process that warms the index waits for it (tests and tools read the Grid releases alone, as before).
  pending: () => warmedAt > 0 && index === null && Date.now() - warmedAt < GATE_MS,
};

/**
 * Starts the first load at boot. Until it lands (for at most GATE_MS) the Grid releases alone are read and no typo is
 * forgiven (exact names still are): a typo of a right answer cannot yet be told from another footballer's name.
 */
export function warmFootballGridNamesakes(): void {
  warmedAt = Date.now();
  refreshIfDue();
}
