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
export function isInQpWindow(endedAt: Date): boolean {
  const ge = new Date(endedAt.getTime() + GE_OFFSET_MS);
  const day = ge.getUTCDay();
  if (day >= 1 && day <= 4) return true;
  return day === 5 && ge.getUTCHours() < 12;
}

/**
 * Saturday (GE) of the week containing endedAt, as 'YYYY-MM-DD', or null when
 * the match ended outside the accrual window.
 */
export function weekKeyFor(endedAt: Date): string | null {
  if (!isInQpWindow(endedAt)) return null;
  const ge = new Date(endedAt.getTime() + GE_OFFSET_MS);
  const saturday = new Date(ge.getTime() + (6 - ge.getUTCDay()) * DAY_MS);
  return saturday.toISOString().slice(0, 10);
}

export function qpForResult(result: 'win' | 'loss'): number {
  return result === 'win' ? WL_QP_WIN : WL_QP_LOSS;
}
