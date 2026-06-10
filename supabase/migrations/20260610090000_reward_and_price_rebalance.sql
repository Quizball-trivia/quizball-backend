-- Reward + price rebalance.
--
-- Daily challenge payouts move from a flat 20 coins/point to per-game values
-- (mirrors COINS_PER_SCORE_POINT in daily-challenges.service.ts):
--   Money Drop  — leftover budget paid 1:1, capped at 1000 (unchanged)
--   True/False  — 200 per correct answer (4 questions per session)
--   Countdown   — 50 per answer found
--   Pick'em     — 500 per correct answer (challenge_type stays 'imposter')
--   Career Path — 250 per correct answer (3 questions per session)
--   High-Low    — 100 per correct round
UPDATE public.daily_challenge_configs
SET coin_reward = CASE challenge_type
  WHEN 'moneyDrop' THEN 1000
  WHEN 'trueFalse' THEN 200
  WHEN 'countdown' THEN 50
  WHEN 'imposter' THEN 500
  WHEN 'careerPath' THEN 250
  WHEN 'highLow' THEN 100
  ELSE coin_reward
END
WHERE challenge_type IN (
  'moneyDrop',
  'trueFalse',
  'countdown',
  'imposter',
  'careerPath',
  'highLow'
);

-- True/False: 4 questions per session.
UPDATE public.daily_challenge_configs
SET settings = jsonb_set(settings, '{questionCount}', '4'::jsonb)
WHERE challenge_type = 'trueFalse';

-- Career Path: 3 questions per session.
UPDATE public.daily_challenge_configs
SET settings = jsonb_set(settings, '{questionCount}', '3'::jsonb)
WHERE challenge_type = 'careerPath';

-- Store avatar prices (price_cents holds the coin cost for coin products).
-- Regular jerseys: 30k each. Georgia + PSG retro stay at 50k.
UPDATE public.store_products
SET
  price_cents = 30000,
  currency = 'coins'
WHERE slug IN (
  'avatar_jersey_real',
  'avatar_jersey_barcelona',
  'avatar_jersey_bayern',
  'avatar_jersey_milan',
  'avatar_jersey_liverpool',
  'avatar_jersey_argentina_retro',
  'avatar_jersey_brazil_retro',
  'avatar_jersey_france_retro',
  'avatar_jersey_germany_retro',
  'avatar_jersey_netherlands_retro'
);

-- Hair / glasses / facial hair.
UPDATE public.store_products
SET
  price_cents = CASE slug
    WHEN 'avatar_hair_girl_basic' THEN 5000
    WHEN 'avatar_hair_hamsik' THEN 10000
    WHEN 'avatar_hair_ramos' THEN 20000
    WHEN 'avatar_hair_ronaldo_brazil' THEN 30000
    WHEN 'avatar_hair_ronaldo_goat' THEN 30000
    WHEN 'avatar_glasses_wayfarer' THEN 10000
    WHEN 'avatar_glasses_round' THEN 15000
    WHEN 'avatar_glasses_aviator' THEN 20000
    WHEN 'avatar_facial_stache' THEN 10000
    WHEN 'avatar_facial_beard' THEN 15000
    ELSE price_cents
  END,
  currency = 'coins'
WHERE slug IN (
  'avatar_hair_girl_basic',
  'avatar_hair_hamsik',
  'avatar_hair_ramos',
  'avatar_hair_ronaldo_brazil',
  'avatar_hair_ronaldo_goat',
  'avatar_glasses_wayfarer',
  'avatar_glasses_round',
  'avatar_glasses_aviator',
  'avatar_facial_stache',
  'avatar_facial_beard'
);
