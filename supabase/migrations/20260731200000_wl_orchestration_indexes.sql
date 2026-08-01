-- WL orchestration hot-path indexes (PR2 review):
--   - the spectator-lag work scan (spec cursor behind live) must not scan
--     every historical tournament each 5-15s tick;
--   - undelivered-event existence per tournament is already covered by
--     idx_wl_events_undelivered (partial), listed here for the record.
CREATE INDEX IF NOT EXISTS idx_wl_tournaments_spec_lag
  ON public.wl_tournaments (id)
  WHERE spec_delivered_seq < live_delivered_seq;
