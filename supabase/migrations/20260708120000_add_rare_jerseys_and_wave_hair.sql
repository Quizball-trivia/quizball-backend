-- Add the "rare" jersey drop (11 club/national jerseys) and the Wave hairstyle
-- to the avatar store. Prices are in in-game coins.

INSERT INTO public.store_products (slug, type, name, description, price_cents, currency, metadata, is_active, sort_order)
VALUES
  (
    'avatar_jersey_man_united',
    'avatar',
    '{"en":"Man United Jersey","ka":"მან იუნაიტედის მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_man_united","slot":"jersey","assetUrl":"/assets/store/jersey_man_united.webp"}'::jsonb,
    true,
    392
  ),
  (
    'avatar_jersey_arsenal',
    'avatar',
    '{"en":"Arsenal Jersey","ka":"არსენალის მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_arsenal","slot":"jersey","assetUrl":"/assets/store/jersey_arsenal.webp"}'::jsonb,
    true,
    393
  ),
  (
    'avatar_jersey_man_city',
    'avatar',
    '{"en":"Man City Jersey","ka":"მან სიტის მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_man_city","slot":"jersey","assetUrl":"/assets/store/jersey_man_city.webp"}'::jsonb,
    true,
    394
  ),
  (
    'avatar_jersey_newcastle',
    'avatar',
    '{"en":"Newcastle Jersey","ka":"ნიუკასლის მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_newcastle","slot":"jersey","assetUrl":"/assets/store/jersey_newcastle.webp"}'::jsonb,
    true,
    395
  ),
  (
    'avatar_jersey_dinamo_tbilisi',
    'avatar',
    '{"en":"Dinamo Tbilisi Jersey","ka":"დინამო თბილისის მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_dinamo_tbilisi","slot":"jersey","assetUrl":"/assets/store/jersey_dinamo_tbilisi.webp"}'::jsonb,
    true,
    396
  ),
  (
    'avatar_jersey_dortmund',
    'avatar',
    '{"en":"Dortmund Jersey","ka":"დორტმუნდის მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_dortmund","slot":"jersey","assetUrl":"/assets/store/jersey_dortmund.webp"}'::jsonb,
    true,
    397
  ),
  (
    'avatar_jersey_italy_home',
    'avatar',
    '{"en":"Italy Home Jersey","ka":"იტალიის საშინაო მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_italy_home","slot":"jersey","assetUrl":"/assets/store/jersey_italy_home.webp"}'::jsonb,
    true,
    398
  ),
  (
    'avatar_jersey_italy_away',
    'avatar',
    '{"en":"Italy Away Jersey","ka":"იტალიის საგარეო მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_italy_away","slot":"jersey","assetUrl":"/assets/store/jersey_italy_away.webp"}'::jsonb,
    true,
    399
  ),
  (
    'avatar_jersey_italy_third',
    'avatar',
    '{"en":"Italy Third Jersey","ka":"იტალიის მესამე მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_italy_third","slot":"jersey","assetUrl":"/assets/store/jersey_italy_third.webp"}'::jsonb,
    true,
    400
  ),
  (
    'avatar_jersey_england_home',
    'avatar',
    '{"en":"England Home Jersey","ka":"ინგლისის საშინაო მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_england_home","slot":"jersey","assetUrl":"/assets/store/jersey_england_home.webp"}'::jsonb,
    true,
    401
  ),
  (
    'avatar_jersey_england_away',
    'avatar',
    '{"en":"England Away Jersey","ka":"ინგლისის საგარეო მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_england_away","slot":"jersey","assetUrl":"/assets/store/jersey_england_away.webp"}'::jsonb,
    true,
    402
  ),
  (
    'avatar_hair_wave',
    'avatar',
    '{"en":"Wave","ka":"ტალღა"}'::jsonb,
    '{"en":"Layered avatar hairstyle","ka":"ავატარის ვარცხნილობა"}'::jsonb,
    20000,
    'coins',
    '{"avatarPartId":"hair_wave","slot":"hair","assetUrl":"/assets/store/hair_wave.webp"}'::jsonb,
    true,
    403
  ),
  (
    'avatar_hair_curly_crop',
    'avatar',
    '{"en":"Curly Crop","ka":"ხუჭუჭა"}'::jsonb,
    '{"en":"Layered avatar hairstyle","ka":"ავატარის ვარცხნილობა"}'::jsonb,
    20000,
    'coins',
    '{"avatarPartId":"hair_curly_crop","slot":"hair","assetUrl":"/assets/store/hair_curly_crop.webp"}'::jsonb,
    true,
    404
  ),
  (
    'avatar_hair_cornrows',
    'avatar',
    '{"en":"Cornrows","ka":"დაწნული"}'::jsonb,
    '{"en":"Layered avatar hairstyle","ka":"ავატარის ვარცხნილობა"}'::jsonb,
    20000,
    'coins',
    '{"avatarPartId":"hair_cornrows","slot":"hair","assetUrl":"/assets/store/hair_cornrows.webp"}'::jsonb,
    true,
    405
  ),
  (
    'avatar_hair_buzz',
    'avatar',
    '{"en":"Buzz Cut","ka":"მოკრეჭილი"}'::jsonb,
    '{"en":"Layered avatar hairstyle","ka":"ავატარის ვარცხნილობა"}'::jsonb,
    20000,
    'coins',
    '{"avatarPartId":"hair_buzz","slot":"hair","assetUrl":"/assets/store/hair_buzz.webp"}'::jsonb,
    true,
    406
  ),
  (
    'avatar_hair_side_part',
    'avatar',
    '{"en":"Side Part","ka":"გვერდითა"}'::jsonb,
    '{"en":"Layered avatar hairstyle","ka":"ავატარის ვარცხნილობა"}'::jsonb,
    20000,
    'coins',
    '{"avatarPartId":"hair_side_part","slot":"hair","assetUrl":"/assets/store/hair_side_part.webp"}'::jsonb,
    true,
    407
  ),
  (
    'avatar_hair_leopard',
    'avatar',
    '{"en":"Leopard","ka":"ლეოპარდი"}'::jsonb,
    '{"en":"Layered avatar hairstyle","ka":"ავატარის ვარცხნილობა"}'::jsonb,
    20000,
    'coins',
    '{"avatarPartId":"hair_leopard","slot":"hair","assetUrl":"/assets/store/hair_leopard.webp"}'::jsonb,
    true,
    408
  ),
  (
    'avatar_facial_handlebar',
    'avatar',
    '{"en":"Handlebar","ka":"გრეხილი ულვაში"}'::jsonb,
    '{"en":"Layered avatar facial hair","ka":"ავატარის ულვაში"}'::jsonb,
    15000,
    'coins',
    '{"avatarPartId":"handlebar","slot":"facialHair","assetUrl":"/assets/store/accessory_handlebar.webp"}'::jsonb,
    true,
    409
  ),
  (
    'avatar_facial_stache_goatee',
    'avatar',
    '{"en":"Stache & Goatee","ka":"ულვაში და წვერი"}'::jsonb,
    '{"en":"Layered avatar facial hair","ka":"ავატარის ულვაში და წვერი"}'::jsonb,
    15000,
    'coins',
    '{"avatarPartId":"stache_goatee","slot":"facialHair","assetUrl":"/assets/store/accessory_stache_goatee.webp"}'::jsonb,
    true,
    410
  ),
  (
    'avatar_jersey_atletico_madrid',
    'avatar',
    '{"en":"Atletico Madrid Jersey","ka":"ატლეტიკო მადრიდის მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_atletico_madrid","slot":"jersey","assetUrl":"/assets/store/jersey_atletico_madrid.webp"}'::jsonb,
    true,
    411
  ),
  (
    'avatar_jersey_napoli',
    'avatar',
    '{"en":"Napoli Jersey","ka":"ნაპოლის მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_napoli","slot":"jersey","assetUrl":"/assets/store/jersey_napoli.webp"}'::jsonb,
    true,
    412
  ),
  (
    'avatar_jersey_inter',
    'avatar',
    '{"en":"Inter Jersey","ka":"ინტერის მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_inter","slot":"jersey","assetUrl":"/assets/store/jersey_inter.webp"}'::jsonb,
    true,
    413
  ),
  (
    'avatar_jersey_roma',
    'avatar',
    '{"en":"Roma Jersey","ka":"რომას მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_roma","slot":"jersey","assetUrl":"/assets/store/jersey_roma.webp"}'::jsonb,
    true,
    414
  ),
  (
    'avatar_jersey_juve',
    'avatar',
    '{"en":"Juventus Jersey","ka":"იუვენტუსის მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_juve","slot":"jersey","assetUrl":"/assets/store/jersey_juve.webp"}'::jsonb,
    true,
    415
  ),
  (
    'avatar_jersey_ajax',
    'avatar',
    '{"en":"Ajax Jersey","ka":"აიაქსის მაისური"}'::jsonb,
    '{"en":"Layered avatar jersey","ka":"ავატარის მაისური"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_ajax","slot":"jersey","assetUrl":"/assets/store/jersey_ajax.webp"}'::jsonb,
    true,
    416
  )
ON CONFLICT (slug) DO UPDATE SET
  type = EXCLUDED.type,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_cents = EXCLUDED.price_cents,
  currency = EXCLUDED.currency,
  metadata = EXCLUDED.metadata,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order;
