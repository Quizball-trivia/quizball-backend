-- Rollback for 20261001120000_raise_cosmetic_prices.sql
-- Returns the 94 coin-priced cosmetics to the prices captured from PRODUCTION
-- on 2026-10-01, before the raise. Scoped to price_cents only, per slug.

BEGIN;

-- Entry hair: 2k -> 1k (1).
UPDATE public.store_products
SET price_cents = 1000
WHERE slug IN (
  'avatar_hair_girl_basic'
)
  AND type = 'avatar'
  AND currency = 'coins';

-- Basic accessories: 3k -> 1.5k (5).
UPDATE public.store_products
SET price_cents = 1500
WHERE slug IN (
  'avatar_earwear_hoop',
  'avatar_earwear_studs',
  'avatar_facial_stache',
  'avatar_glasses_wayfarer',
  'avatar_hair_hamsik'
)
  AND type = 'avatar'
  AND currency = 'coins';

-- Mid accessories: 4k -> 2k (7).
UPDATE public.store_products
SET price_cents = 2000
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

-- Premium hair / glasses: 6k -> 3k (26).
UPDATE public.store_products
SET price_cents = 3000
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

-- Kits + signature hair: 10k -> 5k (53).
UPDATE public.store_products
SET price_cents = 5000
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

-- Rare retro kits: 20k -> 8k (2).
UPDATE public.store_products
SET price_cents = 8000
WHERE slug IN (
  'avatar_jersey_georgia_retro',
  'avatar_jersey_psg_retro'
)
  AND type = 'avatar'
  AND currency = 'coins';

COMMIT;
