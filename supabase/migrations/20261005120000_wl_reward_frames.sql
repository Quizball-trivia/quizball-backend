-- Weekend League podium frames: the card drawn around the avatar, one per
-- podium place, granted in the victory pack next to the "Retro Playmaker"
-- jersey (reward policy v2). Earned, never sold — same rules as the jerseys:
-- is_active = false keeps them out of the store and rejects coin purchases,
-- while inventory and equip checks ignore is_active; the high positive price
-- satisfies the table CHECK and makes an accidental activation no giveaway.
INSERT INTO public.store_products (slug, type, name, description, price_cents, currency, metadata, is_active, sort_order)
VALUES
  ('avatar_frame_wl_champion', 'avatar', '{"en": "Champion frame", "ka": "ჩემპიონის ჩარჩო", "es": "Marco de campeón", "tr": "Şampiyon çerçevesi"}'::jsonb, '{"en": "Weekend League winner reward", "ka": "Weekend League-ის გამარჯვებულის ჯილდო", "es": "Recompensa del campeón de Weekend League", "tr": "Weekend League şampiyon ödülü"}'::jsonb, 100000, 'coins', '{"avatarPartId": "frame_wl_champion", "slot": "frame", "assetUrl": "/assets/store/rewards/wl-frames/champion.svg", "rewardOnly": true}'::jsonb, false, 904),
  ('avatar_frame_wl_runnerup', 'avatar', '{"en": "Runner-up frame", "ka": "მეორე ადგილის ჩარჩო", "es": "Marco de subcampeón", "tr": "İkincilik çerçevesi"}'::jsonb, '{"en": "Weekend League runner-up reward", "ka": "Weekend League-ის მეორე ადგილის ჯილდო", "es": "Recompensa del subcampeón de Weekend League", "tr": "Weekend League ikincilik ödülü"}'::jsonb, 100000, 'coins', '{"avatarPartId": "frame_wl_runnerup", "slot": "frame", "assetUrl": "/assets/store/rewards/wl-frames/runner-up.svg", "rewardOnly": true}'::jsonb, false, 905),
  ('avatar_frame_wl_podium', 'avatar', '{"en": "Podium frame", "ka": "პრიზიორის ჩარჩო", "es": "Marco de podio", "tr": "Podyum çerçevesi"}'::jsonb, '{"en": "Weekend League third-place reward", "ka": "Weekend League-ის მესამე ადგილის ჯილდო", "es": "Recompensa del tercer puesto de Weekend League", "tr": "Weekend League üçüncülük ödülü"}'::jsonb, 100000, 'coins', '{"avatarPartId": "frame_wl_podium", "slot": "frame", "assetUrl": "/assets/store/rewards/wl-frames/podium.svg", "rewardOnly": true}'::jsonb, false, 906)
ON CONFLICT (slug) DO UPDATE SET
  type = EXCLUDED.type,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_cents = EXCLUDED.price_cents,
  currency = EXCLUDED.currency,
  metadata = EXCLUDED.metadata,
  is_active = false,
  sort_order = EXCLUDED.sort_order;
