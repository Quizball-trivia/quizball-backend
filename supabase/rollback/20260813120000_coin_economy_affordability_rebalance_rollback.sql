-- Rollback for 20260813120000_coin_economy_affordability_rebalance.sql
-- Captured from PRODUCTION store_products on 2026-08-13, before the rebalance.
-- Restores every product's exact price_cents / currency / is_active.
-- Coin income constants (season-rp-formula.ts, daily-challenges.service.ts)
-- must be reverted in code separately; this file only covers store pricing.

BEGIN;

UPDATE public.store_products SET price_cents = 1500, currency = 'usd', is_active = true WHERE slug = 'avatar_captain';
UPDATE public.store_products SET price_cents = 15000, currency = 'coins', is_active = true WHERE slug = 'avatar_facial_beard';
UPDATE public.store_products SET price_cents = 15000, currency = 'coins', is_active = true WHERE slug = 'avatar_facial_handlebar';
UPDATE public.store_products SET price_cents = 10000, currency = 'coins', is_active = true WHERE slug = 'avatar_facial_stache';
UPDATE public.store_products SET price_cents = 15000, currency = 'coins', is_active = true WHERE slug = 'avatar_facial_stache_goatee';
UPDATE public.store_products SET price_cents = 20000, currency = 'coins', is_active = true WHERE slug = 'avatar_glasses_aviator';
UPDATE public.store_products SET price_cents = 15000, currency = 'coins', is_active = true WHERE slug = 'avatar_glasses_round';
UPDATE public.store_products SET price_cents = 10000, currency = 'coins', is_active = true WHERE slug = 'avatar_glasses_wayfarer';
UPDATE public.store_products SET price_cents = 1200, currency = 'usd', is_active = true WHERE slug = 'avatar_goalkeeper';
UPDATE public.store_products SET price_cents = 20000, currency = 'coins', is_active = true WHERE slug = 'avatar_hair_buzz';
UPDATE public.store_products SET price_cents = 20000, currency = 'coins', is_active = true WHERE slug = 'avatar_hair_cornrows';
UPDATE public.store_products SET price_cents = 20000, currency = 'coins', is_active = true WHERE slug = 'avatar_hair_curly_crop';
UPDATE public.store_products SET price_cents = 5000, currency = 'coins', is_active = true WHERE slug = 'avatar_hair_girl_basic';
UPDATE public.store_products SET price_cents = 10000, currency = 'coins', is_active = true WHERE slug = 'avatar_hair_hamsik';
UPDATE public.store_products SET price_cents = 20000, currency = 'coins', is_active = true WHERE slug = 'avatar_hair_leopard';
UPDATE public.store_products SET price_cents = 20000, currency = 'coins', is_active = true WHERE slug = 'avatar_hair_ramos';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_hair_ronaldo_brazil';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_hair_ronaldo_goat';
UPDATE public.store_products SET price_cents = 20000, currency = 'coins', is_active = true WHERE slug = 'avatar_hair_side_part';
UPDATE public.store_products SET price_cents = 20000, currency = 'coins', is_active = true WHERE slug = 'avatar_hair_wave';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_ajax';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_argentina_retro';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_arsenal';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_atletico_madrid';
UPDATE public.store_products SET price_cents = 800, currency = 'usd', is_active = true WHERE slug = 'avatar_jersey_away';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_barcelona';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_bayern';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_brazil_retro';
UPDATE public.store_products SET price_cents = 699, currency = 'usd', is_active = true WHERE slug = 'avatar_jersey_champions';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_dinamo_tbilisi';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_dortmund';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_england_away';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_england_home';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_france_retro';
UPDATE public.store_products SET price_cents = 50000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_georgia_retro';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_germany_retro';
UPDATE public.store_products SET price_cents = 2000, currency = 'usd', is_active = true WHERE slug = 'avatar_jersey_gold';
UPDATE public.store_products SET price_cents = 800, currency = 'usd', is_active = true WHERE slug = 'avatar_jersey_home';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_inter';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_italy_away';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_italy_home';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_italy_third';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_juve';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_liverpool';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_man_city';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_man_united';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_milan';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_napoli';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_netherlands_retro';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_newcastle';
UPDATE public.store_products SET price_cents = 50000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_psg_retro';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_real';
UPDATE public.store_products SET price_cents = 1200, currency = 'usd', is_active = true WHERE slug = 'avatar_jersey_retro';
UPDATE public.store_products SET price_cents = 30000, currency = 'coins', is_active = true WHERE slug = 'avatar_jersey_roma';
UPDATE public.store_products SET price_cents = 1500, currency = 'usd', is_active = true WHERE slug = 'avatar_jersey_special';
UPDATE public.store_products SET price_cents = 1000, currency = 'usd', is_active = true WHERE slug = 'avatar_jersey_third';
UPDATE public.store_products SET price_cents = 2500, currency = 'usd', is_active = true WHERE slug = 'avatar_legend';
UPDATE public.store_products SET price_cents = 299, currency = 'usd', is_active = true WHERE slug = 'avatar_lion';
UPDATE public.store_products SET price_cents = 299, currency = 'usd', is_active = true WHERE slug = 'avatar_mbappe';
UPDATE public.store_products SET price_cents = 299, currency = 'usd', is_active = true WHERE slug = 'avatar_messi';
UPDATE public.store_products SET price_cents = 299, currency = 'usd', is_active = true WHERE slug = 'avatar_neymar';
UPDATE public.store_products SET price_cents = 299, currency = 'usd', is_active = true WHERE slug = 'avatar_ronaldinho';
UPDATE public.store_products SET price_cents = 299, currency = 'usd', is_active = true WHERE slug = 'avatar_ronaldo';
UPDATE public.store_products SET price_cents = 500, currency = 'coins', is_active = false WHERE slug = 'avatar_skin_dark';
UPDATE public.store_products SET price_cents = 500, currency = 'coins', is_active = false WHERE slug = 'avatar_skin_dark_alt';
UPDATE public.store_products SET price_cents = 500, currency = 'coins', is_active = false WHERE slug = 'avatar_skin_white_alt';
UPDATE public.store_products SET price_cents = 1000, currency = 'usd', is_active = true WHERE slug = 'avatar_striker';
UPDATE public.store_products SET price_cents = 199, currency = 'usd', is_active = true WHERE slug = 'chance_card_5050';
UPDATE public.store_products SET price_cents = 99, currency = 'usd', is_active = true WHERE slug = 'coin_pack_100';
UPDATE public.store_products SET price_cents = 999, currency = 'usd', is_active = true WHERE slug = 'coin_pack_1200';
UPDATE public.store_products SET price_cents = 1999, currency = 'usd', is_active = true WHERE slug = 'coin_pack_3000';
UPDATE public.store_products SET price_cents = 499, currency = 'usd', is_active = true WHERE slug = 'coin_pack_550';
UPDATE public.store_products SET price_cents = 2000, currency = 'coins', is_active = true WHERE slug = 'ticket_pack_1';
UPDATE public.store_products SET price_cents = 5000, currency = 'coins', is_active = false WHERE slug = 'ticket_pack_10';
UPDATE public.store_products SET price_cents = 999, currency = 'usd', is_active = false WHERE slug = 'ticket_pack_25';
UPDATE public.store_products SET price_cents = 4000, currency = 'coins', is_active = true WHERE slug = 'ticket_pack_3';
UPDATE public.store_products SET price_cents = 5000, currency = 'coins', is_active = true WHERE slug = 'ticket_pack_5';

COMMIT;
