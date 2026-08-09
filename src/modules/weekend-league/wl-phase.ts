/**
 * Weekend League phase machine — pure. The orchestrator applies these
 * decisions with CAS updates; nothing here touches a database or clock.
 *
 * Phase flow (qualifier Saturday, final Sunday):
 *   scheduled → content_pending → ready → entry_open → entry_closed
 *   → checkin → game_live ⇄ break → qualifier_done → final_checkin
 *   → final_live → completed
 * Any non-terminal phase may move to cancelled / voided / paused (paused
 * remembers where it came from and may only resume there).
 */

import type { WlTournamentStatus } from './weekend-league.schemas.js';

export const WL_TERMINAL_STATUSES: readonly WlTournamentStatus[] = [
  'completed', 'cancelled', 'voided',
];

const FLOW: Partial<Record<WlTournamentStatus, WlTournamentStatus[]>> = {
  scheduled: ['content_pending'],
  content_pending: ['ready'],
  ready: ['entry_open'],
  entry_open: ['entry_closed'],
  entry_closed: ['checkin'],
  checkin: ['game_live', 'cancelled'],
  game_live: ['break', 'qualifier_done', 'completed'],
  break: ['game_live'],
  qualifier_done: ['final_checkin'],
  final_checkin: ['final_live', 'completed'],
  final_live: ['completed'],
};

export function wlCanTransition(
  from: WlTournamentStatus,
  to: WlTournamentStatus
): boolean {
  if (from === to) return false;
  if (WL_TERMINAL_STATUSES.includes(from)) return false;
  if (to === 'cancelled' || to === 'voided') return true;
  if (to === 'paused') return from !== 'paused';
  if (from === 'paused') return false; // resume is a dedicated CAS using paused_from_status
  return FLOW[from]?.includes(to) ?? false;
}

export interface WlScheduleView {
  status: WlTournamentStatus;
  entryOpensAtMs: number | null;
  entryClosesAtMs: number | null;
  qualifierStartsAtMs: number | null;
  finalStartsAtMs: number | null;
  checkinWindowMs: number;
}

/**
 * The next TIME-DRIVEN transition that is due at `nowMs`, or null. Content
 * seeding (scheduled→content_pending→ready), game flow (game_live/break
 * advancement) and cancellation are decided by the orchestrator/engine, not
 * by wall-clock alone, so they never appear here.
 */
export function wlDueTransition(
  view: WlScheduleView,
  nowMs: number
): WlTournamentStatus | null {
  switch (view.status) {
    case 'ready':
      return view.entryOpensAtMs != null && nowMs >= view.entryOpensAtMs
        ? 'entry_open'
        : null;
    case 'entry_open':
      return view.entryClosesAtMs != null && nowMs >= view.entryClosesAtMs
        ? 'entry_closed'
        : null;
    case 'entry_closed':
      return view.qualifierStartsAtMs != null
        && nowMs >= view.qualifierStartsAtMs - view.checkinWindowMs
        ? 'checkin'
        : null;
    case 'qualifier_done':
      return view.finalStartsAtMs != null
        && nowMs >= view.finalStartsAtMs - view.checkinWindowMs
        ? 'final_checkin'
        : null;
    default:
      return null;
  }
}

/**
 * The absolute time (ms) of the next time-driven transition after `nowMs`,
 * used to arm wake-up timers. Null when nothing is scheduled ahead.
 */
export function wlNextDueAtMs(view: WlScheduleView, nowMs: number): number | null {
  const candidates: Array<number | null> = (() => {
    switch (view.status) {
      case 'ready': return [view.entryOpensAtMs];
      case 'entry_open': return [view.entryClosesAtMs];
      case 'entry_closed':
        return [view.qualifierStartsAtMs != null
          ? view.qualifierStartsAtMs - view.checkinWindowMs : null];
      case 'checkin': return [view.qualifierStartsAtMs];
      case 'qualifier_done':
        return [view.finalStartsAtMs != null
          ? view.finalStartsAtMs - view.checkinWindowMs : null];
      case 'final_checkin': return [view.finalStartsAtMs];
      default: return [null];
    }
  })();
  const future = candidates.filter((t): t is number => t != null && t > nowMs);
  return future.length > 0 ? Math.min(...future) : null;
}
