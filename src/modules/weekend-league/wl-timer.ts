/**
 * WL wake-up hints on the shared durable timer scheduler. The scheduler is
 * NEVER the source of truth (its pops use replica wall-clocks and it has a
 * local fallback): a fired hint just runs a scoped advance whose every step
 * verifies Redis time and CAS state, and the 5s live reconciler re-arms
 * anything a lost hint missed. Hints are only armed for the near future
 * (question deadlines), far inside the scheduler's 6h payload TTL.
 */

import { scheduleRealtimeTimer } from '../../realtime/realtime-timer-scheduler.js';

export async function scheduleWlTick(tournamentId: string, dueAtMs: number): Promise<void> {
  await scheduleRealtimeTimer(
    'wl_tick',
    tournamentId,
    new Date(dueAtMs),
    { kind: 'wl_tick', tournamentId }
  );
}
