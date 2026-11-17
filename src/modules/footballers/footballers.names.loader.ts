import { logger } from '../../core/logger.js';
import { footballerNamesOf, installFootballerNames } from './footballers.names.js';
import { footballersRepo } from './footballers.repo.js';
import { footballersService } from './footballers.service.js';
import { MATCHER_VERSION } from './footballers.universe.js';

/** How often a replica checks for a newer footballer release (and retries after a failed or empty read). */
export const FOOTBALLER_NAMES_REFRESH_MS = 10 * 60_000;

let loadedRelease: string | null = null;
let started = false;
// Refreshes may overlap (a stalled load must not block the next one): only a refresh started after the one that
// installed may install, so a slow older load never replaces a newer release.
let refreshes = 0;
let installedBy = 0;

async function refresh(): Promise<void> {
  const seq = ++refreshes;
  try {
    const releaseId = await footballersRepo.newestRelease(MATCHER_VERSION);
    if (!releaseId) {
      if (!loadedRelease) logger.warn('No footballer release: answer matchers run without the name veto');
      return;
    }
    if (releaseId === loadedRelease) return;
    const names = footballerNamesOf(await footballersService.universe(releaseId));
    if (seq < installedBy) return;
    installFootballerNames(names);
    installedBy = seq;
    loadedRelease = releaseId;
    logger.info({ releaseId }, 'Footballer names loaded for the answer matchers');
  } catch (error) {
    logger.warn({ err: error }, 'Footballer names could not be loaded; retrying');
  }
}

/**
 * Loads the newest footballer release (shared with the word games through footballersService) at boot, then checks for
 * a newer one on a timer: every replica converges on the same names within one interval.
 */
export function startFootballerNamesLoader(): void {
  if (started) return;
  started = true;
  void refresh();
  setInterval(() => { void refresh(); }, FOOTBALLER_NAMES_REFRESH_MS).unref();
}
