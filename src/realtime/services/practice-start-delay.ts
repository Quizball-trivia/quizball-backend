import { randomInt } from 'node:crypto';
import { config } from '../../core/config.js';

/**
 * Guest "Play now" tables are not paired instantly: a short random wait makes
 * the search feel like real matchmaking (owner, 2026-09-16). One pending wait
 * per key; a newer start or a cancel resolves the older one with `false`.
 * Process-local on purpose — the waiting socket lives on this replica, and a
 * replica restart just lets the client's reconnect retry the start.
 */
const pending = new Map<string, { timer: NodeJS.Timeout; resolve: (proceed: boolean) => void }>();

export function practiceStartDelayMs(): number {
  const min = Math.max(0, config.GUEST_BOT_MATCH_DELAY_MIN_MS);
  const max = Math.max(min, config.GUEST_BOT_MATCH_DELAY_MAX_MS);
  return max === min ? min : randomInt(min, max + 1);
}

export function waitForPracticeStart(key: string, delayMs: number): Promise<boolean> {
  cancelPracticeStart(key);
  if (delayMs <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(key);
      resolve(true);
    }, delayMs);
    pending.set(key, { timer, resolve });
  });
}

/** True when a wait was pending (and is now abandoned). */
export function cancelPracticeStart(key: string): boolean {
  const entry = pending.get(key);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(key);
  entry.resolve(false);
  return true;
}
