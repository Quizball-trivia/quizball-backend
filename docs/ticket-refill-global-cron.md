# Global ticket refill (cron) — replaces per-user lazy refill

## Problem
Tickets refilled 1 per 4h on a **per-user anchor** (`users.tickets_refill_started_at`)
that was set to `now` whenever a player dropped below MAX. Because the anchor
resets on every consume-from-full, an **active player keeps restarting their own
refill clock and effectively never accrues** during play — they only get refills
during long idle gaps. Two players (Thenotorious, Luka_Ivan) reported "I'm not
getting my refill" within a day; the timeline confirmed the clock kept resetting
mid-session.

## Fix
Refill on a **global, predictable cadence for everyone at the same wall-clock
times**: a ticket is granted at **00:00, 04:00, 08:00, 12:00, 16:00, 20:00
Georgia time (Asia/Tbilisi, UTC+4)** to every real user who has room (< 5). Full
users skip the tick (no overflow). No per-user clock, nothing resets on play.

Georgia has no DST (fixed UTC+4), so the grid maps to fixed UTC. pg_cron runs in
UTC. Verified against the prod DB:

| cron UTC hour | Georgia time |
|---|---|
| 00:00 | 04:00 |
| 04:00 | 08:00 |
| 08:00 | 12:00 |
| 12:00 | 16:00 |
| 16:00 | 20:00 |
| 20:00 | 00:00 |

cron expression (UTC): `0 0,4,8,12,16,20 * * *` — fires at exactly 04/08/12/16/20/00
Georgia, i.e. the 0/4/8/12/16/20 Georgia grid. ✔

## Changes
- **Migration** `…_global_ticket_refill_cron.sql`: pg_cron job
  `refill-tickets-every-4h` →
  `UPDATE public.users SET tickets = tickets + 1, updated_at = NOW()
   WHERE tickets < 5 AND is_ai = false AND is_deleted = false
     AND deleted_at IS NULL AND pending_deletion_at IS NULL;`
- **`ticket-refill.service.ts`**: remove the time-based refill math. The cron is
  now the only refill source. `resolveHydratedTicketState` becomes a pure clamp
  to `[0, MAX_TICKETS]` (no elapsed-hours grant, no anchor mutation). Drop the
  now-unused `TICKET_REFILL_INTERVAL_MS`. Consume/purchase keep working
  unchanged; the column is left in place (vestigial — a later migration can drop
  it once nothing reads it).

## Why keep the column for now
`tickets_refill_started_at` is read/written in ~16 repo spots + the wallet
SELECTs. Dropping it is a separate, riskier change on the live economy. Leaving
it inert is safe and reversible; the cron ignores it.
