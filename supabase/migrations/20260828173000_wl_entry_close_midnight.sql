-- Entry deadline moves from Friday 12:00 GE to Friday 24:00 GE (owner request
-- 2026-08-28). Tournament schedule is frozen at creation, so any live
-- pre-checkin row still carries the noon deadline: shift it 12h, and reopen
-- entry when the new deadline is still ahead (the phase machine has no
-- entry_closed -> entry_open edge, so the orchestrator cannot do this itself).
UPDATE wl_tournaments
SET status = CASE
      WHEN status = 'entry_closed'
       AND now() < entry_closes_at + interval '12 hours'
      THEN 'entry_open'
      ELSE status
    END,
    entry_closes_at = entry_closes_at + interval '12 hours',
    updated_at = now()
WHERE is_test = false
  AND status IN ('scheduled', 'content_pending', 'ready', 'entry_open', 'entry_closed')
  AND extract(dow  FROM entry_closes_at AT TIME ZONE 'Asia/Tbilisi') = 5
  AND extract(hour FROM entry_closes_at AT TIME ZONE 'Asia/Tbilisi') = 12;
