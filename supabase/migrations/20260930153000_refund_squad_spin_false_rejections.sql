-- Squad Spin rejected correctly-typed surnames of valid answers: the alias
-- release feeding squad_spin_player_aliases has no surname form for ~40% of
-- players (and none for compound surnames like "Funes Mori"), so a player who
-- typed the surname the reveal itself then showed lost their pot. The resolver
-- now matches name forms directly; this migration refunds every pot lost to a
-- false rejection before the fix.
--
-- A false rejection is an on-time wrong-answer event whose submitted text,
-- normalised the way the resolver normalises input, is a token suffix of a
-- valid answer's normalised full name (its en/exact alias). Under the fixed
-- resolver such an event can no longer be recorded as wrong, so this set is
-- closed: re-running the migration is a no-op via the squad_spin_refund
-- idempotency ledger index.

WITH false_rejections AS (
  SELECT e.id AS event_id, e.user_id, e.pot_before_milli
  FROM squad_spin_events e
  JOIN squad_spin_combos c ON c.id = e.combo_id
  JOIN users u ON u.id = e.user_id
  WHERE e.event_type = 'answer'
    AND e.answer_correct = false
    AND e.answer_late = false
    AND e.pot_before_milli > 0
    AND NOT u.is_ai AND NOT u.is_seed AND NOT u.is_deleted
    AND EXISTS (
      SELECT 1
      FROM squad_spin_player_aliases a
      WHERE a.player_id = ANY (c.answer_ids)
        AND a.locale = 'en'
        AND a.acceptance_policy = 'exact'
        AND a.normalized_alias LIKE '% ' || btrim(regexp_replace(regexp_replace(
              translate(lower(e.submitted_text),
                'áàâäãåçéèêëíìîïñóòôöõúùûüý',
                'aaaaaaceeeeiiiinooooouuuuy'),
              '[^a-z0-9 ]', ' ', 'g'), ' +', ' ', 'g'))
    )
),
ledgered AS (
  INSERT INTO store_transaction_logs (
    event_type, outcome, user_id, coins_delta, coins_delta_minor, tickets_delta,
    inventory_delta, reason, metadata, idempotency_key
  )
  SELECT
    'squad_spin_refund',
    'success',
    fr.user_id,
    (fr.pot_before_milli / 1000)::integer,
    (fr.pot_before_milli / 10)::integer,
    0,
    '{}'::jsonb,
    'squad_spin_false_rejection_surname_alias_gap',
    jsonb_build_object('squad_spin_event_id', fr.event_id, 'pot_before_milli', fr.pot_before_milli),
    'false-reject:' || fr.event_id
  FROM false_rejections fr
  ON CONFLICT DO NOTHING
  RETURNING user_id, coins_delta_minor
),
per_user AS (
  SELECT user_id, sum(coins_delta_minor)::bigint AS delta_minor
  FROM ledgered
  GROUP BY user_id
)
UPDATE users u
SET
  coins = ((u.coins::bigint * 100 + u.coin_fraction_minor::bigint + p.delta_minor) / 100)::integer,
  coin_fraction_minor = ((u.coins::bigint * 100 + u.coin_fraction_minor::bigint + p.delta_minor) % 100)::smallint,
  updated_at = now()
FROM per_user p
WHERE u.id = p.user_id;
