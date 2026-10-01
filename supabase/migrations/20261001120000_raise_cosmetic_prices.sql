-- Raise cosmetic prices to a middle ground between the 2026-08-13 cut and the
-- pre-August tiers (owner decision, 2026-10-01): every tier doubles, and the
-- two rare retro kits go 8k -> 20k. For reference the pre-August tiers were
-- 5k / 10k / 15k / 20k / 30k / 50k, where cosmetics sold 5-13 a week against
-- 52-119 a week since the cut.
--
-- Prices only. The coin income that 20260813120000 paired with its cut (match
-- and daily-challenge payouts), the advertised
-- daily_challenge_configs.coin_reward values and ticket packs are untouched.
--
-- Prices are set per slug with no guard on the current price: 46 products
-- seeded by 20260905072244 at the pre-August tiers were repriced by hand on
-- prod and staging, so a database built from migrations holds different
-- prices for them and a price guard would skip those rows. The slug lists are
-- disjoint, so no row is moved twice.
--
-- Rollback: supabase/rollback/20261001120000_raise_cosmetic_prices_rollback.sql

-- Entry hair: 1k -> 2k (1).
UPDATE public.store_products
SET price_cents = 2000
WHERE slug IN (
  'avatar_hair_girl_basic'
)
  AND type = 'avatar'
  AND currency = 'coins';

-- Basic accessories: 1.5k -> 3k (5).
UPDATE public.store_products
SET price_cents = 3000
WHERE slug IN (
  'avatar_earwear_hoop',
  'avatar_earwear_studs',
  'avatar_facial_stache',
  'avatar_glasses_wayfarer',
  'avatar_hair_hamsik'
)
  AND type = 'avatar'
  AND currency = 'coins';

-- Mid accessories: 2k -> 4k (7).
UPDATE public.store_products
SET price_cents = 4000
WHERE slug IN (
  'avatar_facial_beard',
  'avatar_facial_chin_goatee',
  'avatar_facial_handlebar',
  'avatar_facial_long',
  'avatar_facial_stache_goatee',
  'avatar_glasses_round',
  'avatar_glasses_sport_blue'
)
  AND type = 'avatar'
  AND currency = 'coins';

-- Premium hair / glasses: 3k -> 6k (26).
UPDATE public.store_products
SET price_cents = 6000
WHERE slug IN (
  'avatar_glasses_aviator',
  'avatar_hair_baggio',
  'avatar_hair_beckham_mohawk',
  'avatar_hair_braided_bun',
  'avatar_hair_buzz',
  'avatar_hair_cornrows',
  'avatar_hair_curly_crop',
  'avatar_hair_gullit',
  'avatar_hair_haaland',
  'avatar_hair_high_afro',
  'avatar_hair_leopard',
  'avatar_hair_messy_fringe',
  'avatar_hair_mullet',
  'avatar_hair_neymar_mohawk',
  'avatar_hair_ponytail',
  'avatar_hair_ramos',
  'avatar_hair_ronaldinho',
  'avatar_hair_short_twists',
  'avatar_hair_shoulder_curls',
  'avatar_hair_side_part',
  'avatar_hair_side_shave',
  'avatar_hair_spiky',
  'avatar_hair_valderrama',
  'avatar_hair_wave',
  'avatar_hair_zidane',
  'avatar_headwear_cech'
)
  AND type = 'avatar'
  AND currency = 'coins';

-- Kits + signature hair: 5k -> 10k (53).
UPDATE public.store_products
SET price_cents = 10000
WHERE slug IN (
  'avatar_hair_ronaldo_brazil',
  'avatar_hair_ronaldo_goat',
  'avatar_jersey_ajax',
  'avatar_jersey_argentina_retro',
  'avatar_jersey_arsenal',
  'avatar_jersey_atletico_madrid',
  'avatar_jersey_barcelona',
  'avatar_jersey_bayern',
  'avatar_jersey_benfica',
  'avatar_jersey_boca_juniors',
  'avatar_jersey_brazil_retro',
  'avatar_jersey_celtic',
  'avatar_jersey_chelsea',
  'avatar_jersey_croatia',
  'avatar_jersey_dinamo_tbilisi',
  'avatar_jersey_dortmund',
  'avatar_jersey_england_away',
  'avatar_jersey_england_home',
  'avatar_jersey_fenerbahce',
  'avatar_jersey_france_retro',
  'avatar_jersey_galatasaray',
  'avatar_jersey_germany_retro',
  'avatar_jersey_gold_champion',
  'avatar_jersey_inter',
  'avatar_jersey_italy_away',
  'avatar_jersey_italy_home',
  'avatar_jersey_italy_third',
  'avatar_jersey_japan',
  'avatar_jersey_juve',
  'avatar_jersey_liverpool',
  'avatar_jersey_man_city',
  'avatar_jersey_man_united',
  'avatar_jersey_marseille',
  'avatar_jersey_mexico',
  'avatar_jersey_milan',
  'avatar_jersey_mimino',
  'avatar_jersey_morocco',
  'avatar_jersey_napoli',
  'avatar_jersey_neon_training',
  'avatar_jersey_netherlands_retro',
  'avatar_jersey_newcastle',
  'avatar_jersey_nigeria',
  'avatar_jersey_porto',
  'avatar_jersey_portugal',
  'avatar_jersey_real',
  'avatar_jersey_retro_keeper',
  'avatar_jersey_river_plate',
  'avatar_jersey_roma',
  'avatar_jersey_spain',
  'avatar_jersey_sporting',
  'avatar_jersey_street_football',
  'avatar_jersey_tottenham',
  'avatar_jersey_uruguay'
)
  AND type = 'avatar'
  AND currency = 'coins';

-- Rare retro kits: 8k -> 20k (2).
UPDATE public.store_products
SET price_cents = 20000
WHERE slug IN (
  'avatar_jersey_georgia_retro',
  'avatar_jersey_psg_retro'
)
  AND type = 'avatar'
  AND currency = 'coins';
