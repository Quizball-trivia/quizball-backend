-- Rebalance soft-currency economy.
--
-- Non-coin-pack store products use price_cents as the in-game coin cost.

-- Daily challenges:
-- Money Drop pays the leftover amount, capped at 1000. Other challenges pay
-- 20 coins per correct answer; the config value is kept as the advertised unit
-- reward for incomplete cards, while completed cards return actual coins_awarded.
UPDATE public.daily_challenge_configs
SET coin_reward = CASE
  WHEN challenge_type = 'moneyDrop' THEN 1000
  ELSE 20
END
WHERE challenge_type IN (
  'moneyDrop',
  'trueFalse',
  'clues',
  'countdown',
  'putInOrder',
  'imposter',
  'careerPath',
  'highLow',
  'footballLogic'
);

-- Tickets: 500 coins each.
UPDATE public.store_products
SET
  price_cents = CASE slug
    WHEN 'ticket_pack_1' THEN 500
    WHEN 'ticket_pack_3' THEN 1500
    WHEN 'ticket_pack_5' THEN 2500
    WHEN 'ticket_pack_10' THEN 5000
    ELSE price_cents
  END,
  currency = 'coins',
  is_active = true
WHERE slug IN ('ticket_pack_1', 'ticket_pack_3', 'ticket_pack_5', 'ticket_pack_10');

-- Club jerseys: 1.5k-2.5k coins.
UPDATE public.store_products
SET
  price_cents = CASE slug
    WHEN 'avatar_jersey_real' THEN 2500
    WHEN 'avatar_jersey_barcelona' THEN 2500
    WHEN 'avatar_jersey_bayern' THEN 2200
    WHEN 'avatar_jersey_milan' THEN 2000
    WHEN 'avatar_jersey_liverpool' THEN 1500
    ELSE price_cents
  END,
  currency = 'coins'
WHERE slug IN (
  'avatar_jersey_real',
  'avatar_jersey_barcelona',
  'avatar_jersey_bayern',
  'avatar_jersey_milan',
  'avatar_jersey_liverpool'
);

-- Retro national jerseys: 2k-3.5k coins.
UPDATE public.store_products
SET
  price_cents = CASE slug
    WHEN 'avatar_jersey_argentina_retro' THEN 3500
    WHEN 'avatar_jersey_brazil_retro' THEN 3500
    WHEN 'avatar_jersey_france_retro' THEN 3000
    WHEN 'avatar_jersey_germany_retro' THEN 2500
    WHEN 'avatar_jersey_netherlands_retro' THEN 2000
    ELSE price_cents
  END,
  currency = 'coins'
WHERE slug IN (
  'avatar_jersey_argentina_retro',
  'avatar_jersey_brazil_retro',
  'avatar_jersey_france_retro',
  'avatar_jersey_germany_retro',
  'avatar_jersey_netherlands_retro'
);
