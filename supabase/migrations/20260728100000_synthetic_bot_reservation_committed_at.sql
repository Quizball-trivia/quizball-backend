-- Persistent-bot reservations: explicit draft-commit lifecycle state.
--
-- Root cause of the abort-vs-activate race: draft ACTIVATION flips the lobby to
-- 'active' and commits (releasing the per-lobby advisory lock), but MATCH
-- CREATION (which transfers the reservation onto the match) happens in a much
-- later, separate transaction after the draft plays out — minutes later. The
-- lock cannot be held across the whole draft, so a queued abort that takes the
-- lock during that gap would see "active lobby, no match yet, reservation still
-- lobby-keyed" and free the bot mid-live-draft.
--
-- `committed_at` makes the "a draft has started for this bot — hands off" fact
-- explicit ON THE RESERVATION ITSELF, independent of lobby status or whether the
-- match row exists yet:
--   * set in the SAME locked transaction that flips the lobby to 'active'
--     (activation), covering the entire activate → draft → transfer window;
--   * the abort primitive frees a reservation ONLY when
--     match_id IS NULL AND committed_at IS NULL (no draft has started);
--   * genuine draft-teardown paths (draft-abort, ticket failure, pre-match
--     abandon) explicitly CLEAR committed_at (under the lock) as part of tearing
--     the draft down, so their subsequent abort correctly reclaims the bot.
--
-- Additive, nullable column on the PR1 staging-only table. Safe under
-- expand/contract (old app version simply ignores it).
ALTER TABLE public.synthetic_bot_reservations
  ADD COLUMN IF NOT EXISTS committed_at timestamptz;

COMMENT ON COLUMN public.synthetic_bot_reservations.committed_at IS
  'Set when a draft is activated for this bot (draft started → hands off, even '
  'before match_id is transferred). NULL means no draft has started yet, so the '
  'reservation is abortable. Cleared by genuine draft-teardown before its abort.';
