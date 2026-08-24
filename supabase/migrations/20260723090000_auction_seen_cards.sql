-- =============================================================================
-- Migration: auction_seen_cards
-- Description: Records which auction clue cards a HUMAN player has actually SEEN
--              in an auction match, so cross-match card selection can bias AWAY
--              from recently-seen cards (no-repeat across matches) — mirroring
--              ranked's history-aware question selection.
--
--              Ranked records "seen" implicitly via match_questions.shown_at
--              (it has a per-match questions table). Auction has no per-match
--              card table — cards live only inside the in-memory/redis match
--              state blob — so this dedicated table is the storage seam.
--
-- Query patterns this must serve:
--   1. Record a seen card at round start (dedupe: reseeing bumps seen_at so the
--      recency window slides forward, keeping the table bounded per player):
--        INSERT ... ON CONFLICT (user_id, clue_card_id) DO UPDATE seen_at = NOW()
--      -> unique constraint below
--   2. Recently-seen lookup for the 1-4 humans of a match (hot pick path):
--        SELECT DISTINCT clue_card_id
--        FROM auction_seen_cards
--        WHERE user_id = ANY($1) AND seen_at > now() - make_interval(days => $2)
--      -> idx_auction_seen_cards_user_seen (index scan, small row count/user)
--   3. Retention sweep of rows older than the window (optional cron later):
--        DELETE FROM auction_seen_cards WHERE seen_at < now() - interval '30 days'
--      -> idx_auction_seen_cards_seen_at
-- =============================================================================

CREATE TABLE IF NOT EXISTS auction_seen_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- clue_card_id points at player_clue_cards.id (the same id carried on an
  -- auction card's clueCardId). No FK: content pipeline may hard-delete/replace
  -- clue cards, and a dangling history row is harmless (it just falls out of the
  -- exclusion set) — an FK would risk blocking clue-card maintenance.
  clue_card_id UUID NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Dedupe anchor: one row per (user, card); reseeing bumps seen_at. Keeps the
  -- table bounded to distinct cards per player instead of growing per match.
  CONSTRAINT auction_seen_cards_user_card_key
    UNIQUE (user_id, clue_card_id)
);

-- `CREATE TABLE IF NOT EXISTS` does not repair a pre-existing partial table.
-- Ensure the ON CONFLICT(user_id, clue_card_id) anchor exists regardless.
CREATE UNIQUE INDEX IF NOT EXISTS auction_seen_cards_user_card_key
  ON auction_seen_cards (user_id, clue_card_id);

-- Recently-seen lookup: users of a match ∩ recency window.
CREATE INDEX IF NOT EXISTS idx_auction_seen_cards_user_seen
  ON auction_seen_cards (user_id, seen_at DESC);

-- Retention sweep by age (optional future cron; keeps the sweep index-only).
CREATE INDEX IF NOT EXISTS idx_auction_seen_cards_seen_at
  ON auction_seen_cards (seen_at);
