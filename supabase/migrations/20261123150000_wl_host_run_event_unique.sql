-- Weekly host-run events (Orshabatoba podcast night): the orchestrator opens
-- one row per Monday, keyed by config.event_slug + config.event_date. This
-- index makes that "one per week" hold even if two orchestrator processes
-- (e.g. a stray local backend on the same database) race the creation; the
-- loser's INSERT ... ON CONFLICT DO NOTHING is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS wl_tournaments_host_run_week_uniq
  ON public.wl_tournaments ((config->>'event_slug'), (config->>'event_date'))
  WHERE config ? 'event_date';
