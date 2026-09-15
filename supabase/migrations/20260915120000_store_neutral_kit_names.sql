-- Store: club jerseys lose the real club names (no licence) and take city + colour names
-- (the PES / eFootball convention). Slugs, avatar part ids and asset files keep their internal names.
-- Idempotent: only rows still carrying the old English name are renamed, so later edits are never clobbered.
UPDATE public.store_products p
SET name = jsonb_build_object('en', m.en, 'ka', m.ka, 'es', m.es, 'tr', m.tr)
FROM (VALUES
  ('avatar_jersey_real', 'Real Madrid Jersey', 'Madrid White', 'მადრიდის თეთრი', 'Madrid Blanco', 'Madrid Beyaz'),
  ('avatar_jersey_atletico_madrid', 'Atletico Madrid Jersey', 'Madrid Red & White', 'მადრიდის წითელ-თეთრი', 'Madrid Rojiblanco', 'Madrid Kırmızı-Beyaz'),
  ('avatar_jersey_barcelona', 'Barcelona Jersey', 'Barcelona Blue & Red', 'ბარსელონას ლურჯ-წითელი', 'Barcelona Azul y Rojo', 'Barselona Mavi-Kırmızı'),
  ('avatar_jersey_milan', 'Milan Jersey', 'Milan Red & Black', 'მილანის წითელ-შავი', 'Milán Rojo y Negro', 'Milano Kırmızı-Siyah'),
  ('avatar_jersey_inter', 'Inter Jersey', 'Milan Blue & Black', 'მილანის ლურჯ-შავი', 'Milán Azul y Negro', 'Milano Mavi-Siyah'),
  ('avatar_jersey_juve', 'Juventus Jersey', 'Turin Black & White', 'ტურინის შავ-თეთრი', 'Turín Blanco y Negro', 'Torino Siyah-Beyaz'),
  ('avatar_jersey_napoli', 'Napoli Jersey', 'Naples Blue', 'ნეაპოლის ლურჯი', 'Nápoles Azul', 'Napoli Mavi'),
  ('avatar_jersey_roma', 'Roma Jersey', 'Rome Red & Yellow', 'რომის წითელ-ყვითელი', 'Roma Rojo y Amarillo', 'Roma Kırmızı-Sarı'),
  ('avatar_jersey_liverpool', 'Liverpool Jersey', 'Liverpool Red', 'ლივერპულის წითელი', 'Liverpool Rojo', 'Liverpool Kırmızı'),
  ('avatar_jersey_man_united', 'Man United Jersey', 'Manchester Red', 'მანჩესტერის წითელი', 'Manchester Rojo', 'Manchester Kırmızı'),
  ('avatar_jersey_man_city', 'Man City Jersey', 'Manchester Blue', 'მანჩესტერის ლურჯი', 'Manchester Azul', 'Manchester Mavi'),
  ('avatar_jersey_arsenal', 'Arsenal Jersey', 'London Red', 'ლონდონის წითელი', 'Londres Rojo', 'Londra Kırmızı'),
  ('avatar_jersey_chelsea', 'Chelsea', 'London Blue', 'ლონდონის ლურჯი', 'Londres Azul', 'Londra Mavi'),
  ('avatar_jersey_tottenham', 'Tottenham', 'London White', 'ლონდონის თეთრი', 'Londres Blanco', 'Londra Beyaz'),
  ('avatar_jersey_newcastle', 'Newcastle Jersey', 'Newcastle Black & White', 'ნიუკასლის შავ-თეთრი', 'Newcastle Blanco y Negro', 'Newcastle Siyah-Beyaz'),
  ('avatar_jersey_celtic', 'Celtic', 'Glasgow Green', 'გლაზგოს მწვანე', 'Glasgow Verde', 'Glasgow Yeşil'),
  ('avatar_jersey_bayern', 'Bayern Jersey', 'Munich Red', 'მიუნხენის წითელი', 'Múnich Rojo', 'Münih Kırmızı'),
  ('avatar_jersey_dortmund', 'Dortmund Jersey', 'Dortmund Yellow', 'დორტმუნდის ყვითელი', 'Dortmund Amarillo', 'Dortmund Sarı'),
  ('avatar_jersey_psg_retro', 'PSG Jersey', 'Paris Blue', 'პარიზის ლურჯი', 'París Azul', 'Paris Mavi'),
  ('avatar_jersey_marseille', 'Marseille', 'Marseille White', 'მარსელის თეთრი', 'Marsella Blanco', 'Marsilya Beyaz'),
  ('avatar_jersey_ajax', 'Ajax Jersey', 'Amsterdam Red & White', 'ამსტერდამის წითელ-თეთრი', 'Ámsterdam Rojo y Blanco', 'Amsterdam Kırmızı-Beyaz'),
  ('avatar_jersey_benfica', 'Benfica', 'Lisbon Red', 'ლისაბონის წითელი', 'Lisboa Rojo', 'Lizbon Kırmızı'),
  ('avatar_jersey_sporting', 'Sporting', 'Lisbon Green', 'ლისაბონის მწვანე', 'Lisboa Verde', 'Lizbon Yeşil'),
  ('avatar_jersey_porto', 'Porto', 'Porto Blue & White', 'პორტუს ლურჯ-თეთრი', 'Oporto Azul y Blanco', 'Porto Mavi-Beyaz'),
  ('avatar_jersey_galatasaray', 'Galatasaray', 'Istanbul Red & Yellow', 'სტამბოლის წითელ-ყვითელი', 'Estambul Rojo y Amarillo', 'İstanbul Kırmızı-Sarı'),
  ('avatar_jersey_fenerbahce', 'Fenerbahçe', 'Istanbul Yellow & Navy', 'სტამბოლის ყვითელ-ლურჯი', 'Estambul Amarillo y Azul Marino', 'İstanbul Sarı-Lacivert'),
  ('avatar_jersey_boca_juniors', 'Boca Juniors', 'Buenos Aires Blue & Gold', 'ბუენოს-აირესის ლურჯ-ოქროსფერი', 'Buenos Aires Azul y Oro', 'Buenos Aires Mavi-Altın'),
  ('avatar_jersey_river_plate', 'River Plate', 'Buenos Aires Red Stripe', 'ბუენოს-აირესის წითელი ზოლი', 'Buenos Aires Franja Roja', 'Buenos Aires Kırmızı Şerit'),
  ('avatar_jersey_dinamo_tbilisi', 'Dinamo Tbilisi Jersey', 'Tbilisi Blue & White', 'თბილისის ლურჯ-თეთრი', 'Tiflis Azul y Blanco', 'Tiflis Mavi-Beyaz')
) AS m(slug, old_en, en, ka, es, tr)
WHERE p.slug = m.slug AND p.name->>'en' = m.old_en;
