import { logger } from '../../core/logger.js';
import { activeGreekVersion, greekIndex, greekView } from './footballers.greek.js';
import { awaitFootballerNames, footballerNamesOf, installFootballerNames, stopAwaitingFootballerNames } from './footballers.names.js';
import { footballersRepo } from './footballers.repo.js';
import { footballersService } from './footballers.service.js';
import { MATCHER_VERSION, type Universe } from './footballers.universe.js';

/** How often a replica checks for a newer footballer release or Greek version. */
export const FOOTBALLER_NAMES_REFRESH_MS = 10 * 60_000;
/** After a failed or partial load the next try comes sooner, doubling from the first delay up to the last. */
export const FOOTBALLER_NAMES_RETRY_MS = [5_000, 300_000] as const;
/**
 * How long typos stay held back for names that have not loaded. A read that never settles must not switch typos off for
 * the life of the process: past this the matchers judge without the veto (as before it existed) until the names land.
 */
export const FOOTBALLER_NAMES_GATE_MS = 120_000;
/** A load step that has not settled by now counts as failed (it may still finish: a later refresh then finds it cached). */
export const FOOTBALLER_NAMES_STEP_MS = 60_000;

let loaded: { release: string; greek: string | null } | null = null;
let started = false;
let gateOpenUntil = 0;
// Refreshes may overlap (a stalled load must not block the next one): only a refresh started after the one that
// installed may install, so a slow older load never replaces a newer release.
let refreshes = 0;
let installedBy = 0;
let failures = 0;
let retry: NodeJS.Timeout | null = null;

function within<T>(work: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not settle`)), FOOTBALLER_NAMES_STEP_MS);
    timer.unref();
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

/**
 * The Greek names to read Greek texts with. `ok: false` when an active version could not be read or loaded: Greek
 * typos are then held back ('loading') while the gate is open, and judged without the veto after it.
 */
async function greekNames(release: Universe): Promise<{ version: string | null; view: Universe | 'loading' | null; ok: boolean }> {
  // Decided when the step fails, not before it (a step may take up to FOOTBALLER_NAMES_STEP_MS).
  const failed = () => ({ version: null, view: Date.now() < gateOpenUntil ? ('loading' as const) : null, ok: false });
  let version: string | null;
  try {
    version = await within(activeGreekVersion(), 'Active Greek names version');
  } catch (error) {
    // A database without the Greek tables has no Greek names (the release before they ship).
    if ((error as { code?: string }).code === '42P01') return { version: null, view: null, ok: true };
    logger.warn({ err: error }, 'Active Greek names version could not be read; retrying');
    return failed();
  }
  if (!version) return { version: null, view: null, ok: true };
  try {
    return { version, view: greekView(release, await within(greekIndex(version), 'Greek footballer names')), ok: true };
  } catch (error) {
    logger.warn({ err: error, version }, 'Greek footballer names could not be loaded; retrying');
    return failed();
  }
}

/** True when the names are complete (nothing pending): no early retry is needed. */
async function refresh(): Promise<boolean> {
  const seq = ++refreshes;
  try {
    const releaseId = await within(footballersRepo.newestRelease(MATCHER_VERSION), 'Newest footballer release');
    if (!releaseId) {
      if (installedBy === 0) {
        logger.warn('No footballer release: answer matchers run without the name veto');
        installFootballerNames(null);
      }
      return true;
    }
    const universe = await within(footballersService.universe(releaseId), 'Footballer release');
    const greek = await greekNames(universe);
    if (greek.ok && loaded?.release === releaseId && loaded.greek === greek.version) return true;
    // A failed Greek refresh keeps the complete install of this release (and is retried).
    if (!greek.ok && loaded?.release === releaseId) return false;
    if (seq < installedBy) return true;
    installFootballerNames(footballerNamesOf(universe, greek.view, { pendingUntil: gateOpenUntil }));
    installedBy = seq;
    loaded = greek.ok ? { release: releaseId, greek: greek.version } : null;
    logger.info({ releaseId, greek: greek.version, complete: greek.ok }, 'Footballer names loaded for the answer matchers');
    return greek.ok;
  } catch (error) {
    logger.warn({ err: error }, 'Footballer names could not be loaded; retrying');
    return false;
  }
}

function run(): void {
  void refresh().then((complete) => {
    if (complete) {
      failures = 0;
      return;
    }
    if (retry) return;
    const [first, last] = FOOTBALLER_NAMES_RETRY_MS;
    const delay = Math.min(last, first * 2 ** failures);
    failures += 1;
    retry = setTimeout(() => { retry = null; run(); }, delay);
    retry.unref();
  });
}

/**
 * Loads the newest footballer release (shared with the word games through footballersService) and the active Greek
 * names at boot, then checks for newer ones on a timer: every replica converges on the same names within one interval.
 * Until the first load lands no matcher forgives a typo (exact answers count at once), for at most
 * FOOTBALLER_NAMES_GATE_MS; a failed load is retried within seconds, backing off to minutes.
 */
export function startFootballerNamesLoader(): void {
  if (started) return;
  started = true;
  gateOpenUntil = Date.now() + FOOTBALLER_NAMES_GATE_MS;
  awaitFootballerNames();
  run();
  setTimeout(() => {
    if (loaded) return;
    logger.warn('Footballer names not fully loaded: answer matchers forgive typos without the name veto until they are');
    stopAwaitingFootballerNames();
    // A partial install holds Greek typos back: install again without that hold.
    if (installedBy > 0) run();
  }, FOOTBALLER_NAMES_GATE_MS).unref();
  setInterval(run, FOOTBALLER_NAMES_REFRESH_MS).unref();
}
