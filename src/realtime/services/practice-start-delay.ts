import { randomInt } from 'node:crypto';
import { config } from '../../core/config.js';

/**
 * Guest "Play now" tables are not seated instantly: a short random wait makes
 * the search feel like real matchmaking (owner, 2026-09-16).
 *
 * One pending start per key (`grid:<user>` / `auction:<user>`), identified by
 * a generation token taken at handler entry — before any async work — so an
 * older request that resumes late can never supersede a newer one. The entry
 * lives until the caller finishes seating (or gives up), so a cancel that
 * lands after the timer fired still invalidates the start. Process-local on
 * purpose: the waiting socket lives on this replica, and the client's
 * reconnect simply retries the start.
 */
interface PendingStart {
  token: number;
  searchId: string | null;
  timer: NodeJS.Timeout | null;
  resolve: ((proceed: boolean) => void) | null;
  /** Seating is being written: no longer cancellable. */
  committed: boolean;
}

export type PracticeCancelResult = 'cancelled' | 'mismatch' | 'committed' | 'none';

const pending = new Map<string, PendingStart>();
let nextToken = 1;

export function practiceStartDelayMs(): number {
  const min = Math.max(0, config.GUEST_BOT_MATCH_DELAY_MIN_MS);
  const max = Math.max(min, config.GUEST_BOT_MATCH_DELAY_MAX_MS);
  return max === min ? min : randomInt(min, max + 1);
}

function abandon(entry: PendingStart): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.resolve?.(false);
  entry.timer = null;
  entry.resolve = null;
}

/** Registers a new start for the key; any older pending start is abandoned. */
export function beginPracticeStart(key: string, searchId: string | null = null): number {
  const previous = pending.get(key);
  if (previous) abandon(previous);
  const token = nextToken++;
  pending.set(key, { token, searchId, timer: null, resolve: null, committed: false });
  return token;
}

/** Records the search id the client will cancel with. */
export function attachPracticeSearchId(key: string, token: number, searchId: string): void {
  const entry = pending.get(key);
  if (entry && entry.token === token) entry.searchId = searchId;
}

export function isPracticeStartCurrent(key: string, token: number): boolean {
  return pending.get(key)?.token === token;
}

/** Resolves true after the wait; false when cancelled, superseded or already stale. */
export function waitForPracticeStart(key: string, token: number, delayMs: number): Promise<boolean> {
  const entry = pending.get(key);
  if (!entry || entry.token !== token) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    entry.resolve = resolve;
    entry.timer = setTimeout(() => {
      if (pending.get(key) !== entry) return;
      entry.timer = null;
      entry.resolve = null;
      resolve(true);
    }, delayMs);
  });
}

/**
 * Claims the non-cancellable seating step right before the match/table is
 * written. False when the start is no longer current (cancelled/superseded).
 */
export function claimPracticeSeating(key: string, token: number): boolean {
  const entry = pending.get(key);
  if (!entry || entry.token !== token) return false;
  entry.committed = true;
  return true;
}

/** The start seated its table or gave up: forget it (only if still current). */
export function finishPracticeStart(key: string, token: number): void {
  if (isPracticeStartCurrent(key, token)) pending.delete(key);
}

/**
 * Abandons the pending start. With `searchId`, only a start for that search
 * is cancelled — before the id is announced (entry.searchId null) or for a
 * different id the cancel is stale ('mismatch'). A start already writing its
 * seating reports 'committed' and stays.
 */
export function cancelPracticeStart(key: string, searchId?: string): PracticeCancelResult {
  const entry = pending.get(key);
  if (!entry) return 'none';
  if (searchId && entry.searchId !== searchId) return 'mismatch';
  if (entry.committed) return 'committed';
  abandon(entry);
  pending.delete(key);
  return 'cancelled';
}
