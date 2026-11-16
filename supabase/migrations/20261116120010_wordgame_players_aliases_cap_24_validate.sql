-- Separate transaction from the CHECK replacement: validation allows reads and writes.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.wordgame_players VALIDATE CONSTRAINT chk_wordgame_players_aliases;
