import { config } from '../../core/config.js';
import { reconcileLinkedGuestsInBackground, stopLinkedGuestReconcile } from './hq.repo.js';

// Keeps the HQ rollup's linked-guest repair going when nobody reads HQ; the pulse read shares its throttle.
const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | undefined;

export function startHqLinkedGuestWorker(): void {
  if (timer || (config.NODE_ENV !== 'prod' && config.NODE_ENV !== 'staging')) return;
  timer = setInterval(() => void reconcileLinkedGuestsInBackground(), TICK_MS);
  timer.unref();
}

export async function stopHqLinkedGuestWorker(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  await stopLinkedGuestReconcile();
}
