-- Coin economy affordability rebalance.
--
-- Context (prod measurement, 2026-08-13): median real-user balance was 600 coins
-- and 45% of users still sat on the untouched 500-coin signup grant, while the
-- jersey tier cost 30k. Only 66 of 7,219 users could afford any jersey, and 22
-- cosmetics added on 2026-07-11 had never sold a single unit. The 2026-06-10
-- rebalance raised jerseys 2.5k -> 30k two days after 20260608120000 priced them
-- at 1.5k-2.5k; cosmetic sales fell 93% and never recovered.
--
-- This migration pairs the price cut with the income raise in
-- season-rp-formula.ts (win 300->700, loss 100->250) and
-- daily-challenges.service.ts (highLow 100->400, countdown 50->75,
-- careerPath 250->300, moneyDrop cap 1000->1500).
--
-- Ticket packs are deliberately UNCHANGED (2k/4k/5k): they are the primary coin
-- sink and the only consistently-selling product line.
--
-- Rollback: supabase/rollback/20260813120000_coin_economy_affordability_rebalance_rollback.sql restores every product's
-- exact pre-migration price_cents / currency / is_active.

-- Entry tier: avatar_hair_girl_basic drops to 1k so the ~45% of users holding
-- only the 500-coin signup grant have a reachable first purchase.
--
-- NOTE: the three avatar_skin_* products (500 coins, currently inactive) are
-- deliberately NOT reactivated here. 20260501120000 disabled them because skin
-- tones are free avatar choices, not paid products; charging for them would be
-- a regression. A dedicated cheap cosmetic is the right entry tier instead.
UPDATE public.store_products
SET price_cents = 1000
WHERE slug = 'avatar_hair_girl_basic'
  AND type = 'avatar'
  AND currency = 'coins';

-- Basic accessories: 10k -> 1.5k.
UPDATE public.store_products
SET price_cents = 1500
WHERE slug IN (
  'avatar_hair_hamsik',
  'avatar_glasses_wayfarer',
  'avatar_facial_stache'
)
  AND type = 'avatar'
  AND currency = 'coins';

-- Mid accessories: 15k -> 2k.
UPDATE public.store_products
SET price_cents = 2000
WHERE slug IN (
  'avatar_facial_beard',
  'avatar_glasses_round',
  'avatar_facial_handlebar',
  'avatar_facial_stache_goatee'
)
  AND type = 'avatar'
  AND currency = 'coins';

-- Premium hair / glasses: 20k -> 3k.
UPDATE public.store_products
SET price_cents = 3000
WHERE slug IN (
  'avatar_glasses_aviator',
  'avatar_hair_ramos',
  'avatar_hair_wave',
  'avatar_hair_curly_crop',
  'avatar_hair_cornrows',
  'avatar_hair_buzz',
  'avatar_hair_side_part',
  'avatar_hair_leopard'
)
  AND type = 'avatar'
  AND currency = 'coins';

-- Club jerseys + signature hair: 30k -> 5k.
UPDATE public.store_products
SET price_cents = 5000
WHERE slug IN (
  'avatar_hair_ronaldo_brazil',
  'avatar_hair_ronaldo_goat',
  'avatar_jersey_real',
  'avatar_jersey_barcelona',
  'avatar_jersey_bayern',
  'avatar_jersey_milan',
  'avatar_jersey_liverpool',
  'avatar_jersey_man_united',
  'avatar_jersey_arsenal',
  'avatar_jersey_man_city',
  'avatar_jersey_newcastle',
  'avatar_jersey_dortmund',
  'avatar_jersey_atletico_madrid',
  'avatar_jersey_napoli',
  'avatar_jersey_inter',
  'avatar_jersey_roma',
  'avatar_jersey_juve',
  'avatar_jersey_ajax',
  'avatar_jersey_dinamo_tbilisi',
  'avatar_jersey_italy_home',
  'avatar_jersey_italy_away',
  'avatar_jersey_italy_third',
  'avatar_jersey_england_home',
  'avatar_jersey_england_away',
  'avatar_jersey_argentina_retro',
  'avatar_jersey_brazil_retro',
  'avatar_jersey_france_retro',
  'avatar_jersey_germany_retro',
  'avatar_jersey_netherlands_retro'
)
  AND type = 'avatar'
  AND currency = 'coins';

-- Rare retro kits stay the aspirational top of the catalogue: 50k -> 8k.
UPDATE public.store_products
SET price_cents = 8000
WHERE slug IN (
  'avatar_jersey_georgia_retro',
  'avatar_jersey_psg_retro'
)
  AND type = 'avatar'
  AND currency = 'coins';

-- Advertised daily-challenge rewards. daily_challenge_configs.coin_reward is
-- what the challenge list shows BEFORE a user completes a challenge (after
-- completion the actual coins_awarded is shown instead), so leaving these at
-- the old values would advertise a smaller reward than the code now pays.
-- Mirrors COINS_PER_SCORE_POINT in daily-challenges.service.ts, expressed as
-- the per-session headline the list already used: per-point value times the
-- questions per session for fixed-length games, and the cap for moneyDrop.
UPDATE public.daily_challenge_configs
SET coin_reward = CASE challenge_type
  WHEN 'moneyDrop' THEN 1500
  WHEN 'countdown' THEN 75
  WHEN 'careerPath' THEN 300
  WHEN 'highLow' THEN 400
  ELSE coin_reward
END
WHERE challenge_type IN ('moneyDrop', 'countdown', 'careerPath', 'highLow');
