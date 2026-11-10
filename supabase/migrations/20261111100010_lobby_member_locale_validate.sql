-- Separate transaction from the column/CHECK: validation takes a weaker lock.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.lobby_members VALIDATE CONSTRAINT lobby_members_locale_check;
