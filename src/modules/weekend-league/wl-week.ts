/**
 * Weekend League QP calendar — pure, side-effect-free.
 *
 * QP eligibility is derived SOLELY from the match's immutable ended_at and
 * fixed Georgia time (UTC+4, no DST), never from tournament/orchestrator state:
 * a missing or late tournament row must not be able to lose a player's QP.
 * The week key is the Saturday (GE date) of the accrual week.
 */

const GE_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const WL_QP_WIN = 25;
export const WL_QP_LOSS = 10;
export const WL_QP_TARGET = 200;

/** Accrual window: Monday 00:00 GE ≤ t < Friday 12:00 GE. */
/**
 * QP is a RUNNING balance — every ranked match accrues, every day (the old
 * Mon–Fri window predates the running-balance pivot and silently zeroed
 * weekend grinding). Retained for the entry-cutoff boundary only.
 */
export function isInQpWindow(endedAt: Date): boolean {
  const ge = new Date(endedAt.getTime() + GE_OFFSET_MS);
  const day = ge.getUTCDay();
  if (day >= 1 && day <= 4) return true;
  return day === 5 && ge.getUTCHours() < 12;
}

/**
 * The event week a match's QP arrives in time for, as 'YYYY-MM-DD' (that
 * week's Saturday, GE). Entry closes Friday 12:00 GE, so matches played
 * after the cutoff — late Friday, Saturday, Sunday — credit the NEXT
 * event's week. Display context only: the balance itself sums the ledger
 * since the player's last ticket claim, regardless of week.
 */
export function weekKeyFor(endedAt: Date): string | null {
  const ge = new Date(endedAt.getTime() + GE_OFFSET_MS);
  const day = ge.getUTCDay(); // 0 Sun … 6 Sat
  let daysToSaturday = (6 - day + 7) % 7; // this week's Saturday
  if (!isInQpWindow(endedAt)) {
    // Past the Friday-noon cutoff: roll to the next event's Saturday.
    daysToSaturday = day === 6 ? 7 : day === 0 ? 6 : daysToSaturday + 7;
  }
  const saturday = new Date(ge.getTime() + daysToSaturday * DAY_MS);
  return saturday.toISOString().slice(0, 10);
}

export function qpForResult(result: 'win' | 'loss'): number {
  return result === 'win' ? WL_QP_WIN : WL_QP_LOSS;
}

export interface WlEventSchedule {
  weekKey: string;
  entryOpensAtMs: number;
  entryClosesAtMs: number;
  qualifierStartsAtMs: number;
  finalStartsAtMs: number;
}

/**
 * The current-or-next applicable weekly event for a moment in time. A week's
 * event belongs to it through Sunday's final (Sunday maps to the PREVIOUS
 * day's Saturday key); once the final start has passed, the next Saturday is
 * applicable. This is the single source of the event calendar — weekly
 * creation, bootstrap and selection all derive from it, so a Thursday
 * evening or weekend deploy can never skip or shadow the ongoing event.
 */
export function wlUpcomingEventSchedule(nowMs: number): WlEventSchedule {
  const ge = new Date(nowMs + GE_OFFSET_MS);
  const dow = ge.getUTCDay();
  const toSaturdayDays = dow === 0 ? -1 : 6 - dow;
  let saturday = new Date(Date.UTC(
    ge.getUTCFullYear(), ge.getUTCMonth(), ge.getUTCDate() + toSaturdayDays
  ));
  let schedule = scheduleForSaturday(saturday);
  if (nowMs >= schedule.finalStartsAtMs) {
    saturday = new Date(saturday.getTime() + 7 * DAY_MS);
    schedule = scheduleForSaturday(saturday);
  }
  return schedule;
}

function scheduleForSaturday(saturdayGeDate: Date): WlEventSchedule {
  const weekKey = saturdayGeDate.toISOString().slice(0, 10);
  const saturdayMidnightUtc = saturdayGeDate.getTime() - GE_OFFSET_MS;
  return {
    weekKey,
    entryOpensAtMs: saturdayMidnightUtc - 5 * DAY_MS,            // Mon 00:00 GE
    entryClosesAtMs: saturdayMidnightUtc - DAY_MS + 12 * 3600_000, // Fri 12:00 GE
    qualifierStartsAtMs: saturdayMidnightUtc + 14 * 3600_000,    // Sat 14:00 GE
    finalStartsAtMs: saturdayMidnightUtc + DAY_MS + 14 * 3600_000, // Sun 14:00 GE
  };
}
