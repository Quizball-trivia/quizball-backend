-- Index work for ai_kind classification (see 20260727150000).
--
-- Kept OUT of the classification migration so the users-table write-block
-- window is just these two builds, not the whole classification transaction.
-- Deliberately NOT built with concurrent (non-blocking) builds: the deploy runner holds its advisory
-- lock in an open transaction for the entire run, and concurrent index
-- builds on the second connection can wait behind that transaction
-- forever (observed self-deadlock on the runner locally). Standard builds on
-- users measure ~50ms each at the current ~30k rows (~105ms total write
-- block), which is far below deploy-visible impact.
--
-- Ordering: the replacement unique index is created BEFORE the old one is
-- dropped, so nickname uniqueness enforcement never has a gap. The new
-- predicate covers exactly the same rows as the old index today (persistent
-- bots don't exist yet), so no duplicate conflicts are possible at build time.
-- Roster-bot names must be covered before any roster row exists: a human
-- registering a bot's exact name — or the generator racing a signup — would
-- out the bot.
--
-- Idempotent: safe under manual apply + deploy runner re-run.

CREATE INDEX IF NOT EXISTS idx_users_ai_kind
  ON public.users (ai_kind)
  WHERE ai_kind IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_lower_nickname_claimable
  ON public.users (lower(nickname))
  WHERE (is_ai = false OR ai_kind = 'persistent')
    AND is_deleted = false
    AND deleted_at IS NULL
    AND pending_deletion_at IS NULL
    AND nickname IS NOT NULL
    AND length(nickname) > 0;

DROP INDEX IF EXISTS public.uq_users_lower_nickname_real;
