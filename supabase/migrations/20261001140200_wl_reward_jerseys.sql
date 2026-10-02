-- Weekend League podium jerseys ("Retro Playmaker" edition): earned, never sold.
--
-- is_active = false keeps them out of the store listing and makes the coin
-- purchase route reject them; inventory and equip checks do not look at
-- is_active, so a granted jersey is owned and wearable. price_cents must be
-- positive by the table CHECK; it is deliberately high so an accidental
-- activation is not a giveaway.
INSERT INTO public.store_products (slug, type, name, description, price_cents, currency, metadata, is_active, sort_order)
VALUES
  ('avatar_jersey_wl_retro_home', 'avatar', '{"en": "Retro Playmaker Home", "ka": "რეტრო პლეიმეიკერი — საშინაო", "es": "Retro Playmaker local", "tr": "Retro Playmaker İç Saha"}'::jsonb, '{"en": "Weekend League podium reward", "ka": "Weekend League-ის საპრიზო ჯილდო", "es": "Recompensa de podio de Weekend League", "tr": "Weekend League podyum ödülü"}'::jsonb, 100000, 'coins', '{"avatarPartId": "jersey_wl_retro_home", "slot": "jersey", "assetUrl": "/assets/store/rewards/wl-retro-playmaker/home-v3.webp", "rewardOnly": true}'::jsonb, false, 901),
  ('avatar_jersey_wl_retro_away', 'avatar', '{"en": "Retro Playmaker Away", "ka": "რეტრო პლეიმეიკერი — საგარეო", "es": "Retro Playmaker visitante", "tr": "Retro Playmaker Deplasman"}'::jsonb, '{"en": "Weekend League podium reward", "ka": "Weekend League-ის საპრიზო ჯილდო", "es": "Recompensa de podio de Weekend League", "tr": "Weekend League podyum ödülü"}'::jsonb, 100000, 'coins', '{"avatarPartId": "jersey_wl_retro_away", "slot": "jersey", "assetUrl": "/assets/store/rewards/wl-retro-playmaker/away-v2.webp", "rewardOnly": true}'::jsonb, false, 902),
  ('avatar_jersey_wl_retro_training', 'avatar', '{"en": "Retro Playmaker Training", "ka": "რეტრო პლეიმეიკერი — სავარჯიშო", "es": "Retro Playmaker de entrenamiento", "tr": "Retro Playmaker Antrenman"}'::jsonb, '{"en": "Weekend League podium reward", "ka": "Weekend League-ის საპრიზო ჯილდო", "es": "Recompensa de podio de Weekend League", "tr": "Weekend League podyum ödülü"}'::jsonb, 100000, 'coins', '{"avatarPartId": "jersey_wl_retro_training", "slot": "jersey", "assetUrl": "/assets/store/rewards/wl-retro-playmaker/training-v4.webp", "rewardOnly": true}'::jsonb, false, 903)
ON CONFLICT (slug) DO UPDATE SET
  type = EXCLUDED.type,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_cents = EXCLUDED.price_cents,
  currency = EXCLUDED.currency,
  metadata = EXCLUDED.metadata,
  is_active = false,
  sort_order = EXCLUDED.sort_order;
