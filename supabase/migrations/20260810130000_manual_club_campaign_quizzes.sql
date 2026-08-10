-- Add the 16 club landing-page quizzes supplied in the SEO content pack.
-- Existing Arsenal, Chelsea and Manchester City categories keep their verified
-- database questions. Clubs without a category receive the ten supplied,
-- public-only questions. Every assigned question is excluded from ranked play.

INSERT INTO public.campaign_quizzes (slug, title, status)
VALUES
  ('arsenal', 'Arsenal Quiz — Test Your Gunners Knowledge', 'draft'),
  ('aston-villa', 'Aston Villa Quiz — Test Your Villans Knowledge', 'draft'),
  ('bournemouth', 'Bournemouth Quiz — Test Your Cherries Knowledge', 'draft'),
  ('brentford', 'Brentford Quiz — Test Your Bees Knowledge', 'draft'),
  ('brighton', 'Brighton Quiz — Test Your Seagulls Knowledge', 'draft'),
  ('chelsea', 'Chelsea Quiz — Test Your Blues Knowledge', 'draft'),
  ('coventry-city', 'Coventry City Quiz — Test Your Sky Blues Knowledge', 'draft'),
  ('crystal-palace', 'Crystal Palace Quiz — Test Your Eagles Knowledge', 'draft'),
  ('fulham', 'Fulham Quiz — Test Your Cottagers Knowledge', 'draft'),
  ('hull-city', 'Hull City Quiz — Test Your Tigers Knowledge', 'draft'),
  ('ipswich-town', 'Ipswich Town Quiz — Test Your Tractor Boys Knowledge', 'draft'),
  ('leeds-united', 'Leeds United Quiz — Test Your Whites Knowledge', 'draft'),
  ('manchester-city', 'Manchester City Quiz — Test Your City Knowledge', 'draft'),
  ('newcastle-united', 'Newcastle United Quiz — Test Your Magpies Knowledge', 'draft'),
  ('nottingham-forest', 'Nottingham Forest Quiz — Test Your Reds Knowledge', 'draft'),
  ('sunderland', 'Sunderland Quiz — Test Your Black Cats Knowledge', 'draft')
ON CONFLICT (slug) DO UPDATE
SET title = EXCLUDED.title,
    status = EXCLUDED.status,
    updated_at = NOW();

INSERT INTO public.categories (slug, name, is_active)
VALUES
  ('aston-villa', '{"en": "Aston Villa"}'::jsonb, TRUE),
  ('bournemouth', '{"en": "Bournemouth"}'::jsonb, TRUE),
  ('brentford', '{"en": "Brentford"}'::jsonb, TRUE),
  ('brighton', '{"en": "Brighton"}'::jsonb, TRUE),
  ('coventry-city', '{"en": "Coventry City"}'::jsonb, TRUE),
  ('crystal-palace', '{"en": "Crystal Palace"}'::jsonb, TRUE),
  ('fulham', '{"en": "Fulham"}'::jsonb, TRUE),
  ('hull-city', '{"en": "Hull City"}'::jsonb, TRUE),
  ('ipswich-town', '{"en": "Ipswich Town"}'::jsonb, TRUE),
  ('leeds-united', '{"en": "Leeds United"}'::jsonb, TRUE),
  ('newcastle-united', '{"en": "Newcastle United"}'::jsonb, TRUE),
  ('nottingham-forest', '{"en": "Nottingham Forest"}'::jsonb, TRUE),
  ('sunderland', '{"en": "Sunderland"}'::jsonb, TRUE)
ON CONFLICT (slug) DO NOTHING;

CREATE TEMP TABLE manual_campaign_questions (
  quiz_slug TEXT NOT NULL,
  display_order SMALLINT NOT NULL,
  difficulty TEXT NOT NULL,
  prompt TEXT NOT NULL,
  payload JSONB NOT NULL
) ON COMMIT DROP;

INSERT INTO manual_campaign_questions (quiz_slug, display_order, difficulty, prompt, payload)
VALUES
  ('aston-villa', 1, 'easy', 'In which year did Aston Villa win the European Cup?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "1978"}, "is_correct": false}, {"id": "b", "text": {"en": "1980"}, "is_correct": false}, {"id": "c", "text": {"en": "1982"}, "is_correct": true}, {"id": "d", "text": {"en": "1984"}, "is_correct": false}]}'::jsonb),
  ('aston-villa', 2, 'easy', 'Who scored the winning goal in that European Cup final against Bayern Munich?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Gary Shaw"}, "is_correct": false}, {"id": "b", "text": {"en": "Peter Withe"}, "is_correct": true}, {"id": "c", "text": {"en": "Tony Morley"}, "is_correct": false}, {"id": "d", "text": {"en": "Dennis Mortimer"}, "is_correct": false}]}'::jsonb),
  ('aston-villa', 3, 'easy', 'What is Aston Villa’s home ground?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "St Andrew’s"}, "is_correct": false}, {"id": "b", "text": {"en": "Villa Park"}, "is_correct": true}, {"id": "c", "text": {"en": "The Hawthorns"}, "is_correct": false}, {"id": "d", "text": {"en": "Molineux"}, "is_correct": false}]}'::jsonb),
  ('aston-villa', 4, 'easy', 'What is the name of Villa Park’s famous stand behind the goal?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Kop"}, "is_correct": false}, {"id": "b", "text": {"en": "The Holte End"}, "is_correct": true}, {"id": "c", "text": {"en": "The Stretford End"}, "is_correct": false}, {"id": "d", "text": {"en": "The Gallowgate"}, "is_correct": false}]}'::jsonb),
  ('aston-villa', 5, 'medium', 'What are Aston Villa’s traditional colours?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Claret and blue"}, "is_correct": true}, {"id": "b", "text": {"en": "Red and white"}, "is_correct": false}, {"id": "c", "text": {"en": "Blue and white"}, "is_correct": false}, {"id": "d", "text": {"en": "Green and gold"}, "is_correct": false}]}'::jsonb),
  ('aston-villa', 6, 'medium', 'Aston Villa were founder members of the Football League in 1888. True or false?', '{"type": "true_false", "options": [{"id": "true", "text": {"en": "True"}, "is_correct": true}, {"id": "false", "text": {"en": "False"}, "is_correct": false}]}'::jsonb),
  ('aston-villa', 7, 'medium', 'Which academy graduate captained Villa before a £100m move to Manchester City in 2021?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Jack Grealish"}, "is_correct": true}, {"id": "b", "text": {"en": "Ollie Watkins"}, "is_correct": false}, {"id": "c", "text": {"en": "John McGinn"}, "is_correct": false}, {"id": "d", "text": {"en": "Tyrone Mings"}, "is_correct": false}]}'::jsonb),
  ('aston-villa', 8, 'hard', 'Who are Villa’s rivals in the Second City derby?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "West Brom"}, "is_correct": false}, {"id": "b", "text": {"en": "Wolves"}, "is_correct": false}, {"id": "c", "text": {"en": "Birmingham City"}, "is_correct": true}, {"id": "d", "text": {"en": "Coventry City"}, "is_correct": false}]}'::jsonb),
  ('aston-villa', 9, 'hard', 'What is Aston Villa’s nickname?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Villans"}, "is_correct": true}, {"id": "b", "text": {"en": "The Baggies"}, "is_correct": false}, {"id": "c", "text": {"en": "The Saddlers"}, "is_correct": false}, {"id": "d", "text": {"en": "The Foxes"}, "is_correct": false}]}'::jsonb),
  ('aston-villa', 10, 'hard', 'Which Spanish manager returned Villa to the Champions League places in 2024?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Rafael Benítez"}, "is_correct": false}, {"id": "b", "text": {"en": "Unai Emery"}, "is_correct": true}, {"id": "c", "text": {"en": "Julen Lopetegui"}, "is_correct": false}, {"id": "d", "text": {"en": "Mikel Arteta"}, "is_correct": false}]}'::jsonb),
  ('bournemouth', 1, 'easy', 'What is AFC Bournemouth’s nickname?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Cherries"}, "is_correct": true}, {"id": "b", "text": {"en": "The Berries"}, "is_correct": false}, {"id": "c", "text": {"en": "The Pilgrims"}, "is_correct": false}, {"id": "d", "text": {"en": "The Grecians"}, "is_correct": false}]}'::jsonb),
  ('bournemouth', 2, 'easy', 'Which manager took Bournemouth from League Two to the Premier League?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Harry Redknapp"}, "is_correct": false}, {"id": "b", "text": {"en": "Eddie Howe"}, "is_correct": true}, {"id": "c", "text": {"en": "Scott Parker"}, "is_correct": false}, {"id": "d", "text": {"en": "Jason Tindall"}, "is_correct": false}]}'::jsonb),
  ('bournemouth', 3, 'easy', 'In which year did Bournemouth reach the Premier League for the first time?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "2013"}, "is_correct": false}, {"id": "b", "text": {"en": "2014"}, "is_correct": false}, {"id": "c", "text": {"en": "2015"}, "is_correct": true}, {"id": "d", "text": {"en": "2016"}, "is_correct": false}]}'::jsonb),
  ('bournemouth', 4, 'easy', 'What is Bournemouth’s home stadium currently known as?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Vitality Stadium"}, "is_correct": true}, {"id": "b", "text": {"en": "St Mary’s"}, "is_correct": false}, {"id": "c", "text": {"en": "Fratton Park"}, "is_correct": false}, {"id": "d", "text": {"en": "The Hawthorns"}, "is_correct": false}]}'::jsonb),
  ('bournemouth', 5, 'medium', 'In which English county is Bournemouth located?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Devon"}, "is_correct": false}, {"id": "b", "text": {"en": "Hampshire"}, "is_correct": false}, {"id": "c", "text": {"en": "Somerset"}, "is_correct": false}, {"id": "d", "text": {"en": "Dorset"}, "is_correct": true}]}'::jsonb),
  ('bournemouth', 6, 'medium', 'What colours are Bournemouth’s traditional home stripes?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Red and white"}, "is_correct": false}, {"id": "b", "text": {"en": "Red and black"}, "is_correct": true}, {"id": "c", "text": {"en": "Blue and black"}, "is_correct": false}, {"id": "d", "text": {"en": "Claret and blue"}, "is_correct": false}]}'::jsonb),
  ('bournemouth', 7, 'medium', 'Which Basque coach took charge of the Cherries in 2023?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Unai Emery"}, "is_correct": false}, {"id": "b", "text": {"en": "Mikel Arteta"}, "is_correct": false}, {"id": "c", "text": {"en": "Andoni Iraola"}, "is_correct": true}, {"id": "d", "text": {"en": "Julen Lopetegui"}, "is_correct": false}]}'::jsonb),
  ('bournemouth', 8, 'hard', 'What does the “AFC” in AFC Bournemouth stand for?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Athletic Football Club"}, "is_correct": true}, {"id": "b", "text": {"en": "Association Football Club"}, "is_correct": false}, {"id": "c", "text": {"en": "Amateur Football Club"}, "is_correct": false}, {"id": "d", "text": {"en": "Atlantic Football Club"}, "is_correct": false}]}'::jsonb),
  ('bournemouth', 9, 'hard', 'For years Bournemouth’s ground held a distinctive Premier League record. Which one?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Oldest stadium"}, "is_correct": false}, {"id": "b", "text": {"en": "Smallest capacity"}, "is_correct": true}, {"id": "c", "text": {"en": "Furthest north"}, "is_correct": false}, {"id": "d", "text": {"en": "Biggest pitch"}, "is_correct": false}]}'::jsonb),
  ('bournemouth', 10, 'hard', 'Bournemouth suffered a record 9–0 Premier League defeat in 2022 against which club?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Manchester City"}, "is_correct": false}, {"id": "b", "text": {"en": "Arsenal"}, "is_correct": false}, {"id": "c", "text": {"en": "Liverpool"}, "is_correct": true}, {"id": "d", "text": {"en": "Chelsea"}, "is_correct": false}]}'::jsonb),
  ('brentford', 1, 'easy', 'What is Brentford’s nickname?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Bees"}, "is_correct": true}, {"id": "b", "text": {"en": "The Hornets"}, "is_correct": false}, {"id": "c", "text": {"en": "The Wasps"}, "is_correct": false}, {"id": "d", "text": {"en": "The Robins"}, "is_correct": false}]}'::jsonb),
  ('brentford', 2, 'easy', 'In which year did Brentford win promotion to the Premier League, ending a 74-year top-flight absence?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "2019"}, "is_correct": false}, {"id": "b", "text": {"en": "2020"}, "is_correct": false}, {"id": "c", "text": {"en": "2021"}, "is_correct": true}, {"id": "d", "text": {"en": "2022"}, "is_correct": false}]}'::jsonb),
  ('brentford', 3, 'easy', 'Brentford’s old ground was famous for having a pub on every corner. What was it called?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Plough Lane"}, "is_correct": false}, {"id": "b", "text": {"en": "Griffin Park"}, "is_correct": true}, {"id": "c", "text": {"en": "Loftus Road"}, "is_correct": false}, {"id": "d", "text": {"en": "Vicarage Road"}, "is_correct": false}]}'::jsonb),
  ('brentford', 4, 'easy', 'Which Danish manager led Brentford into the Premier League?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Michael Laudrup"}, "is_correct": false}, {"id": "b", "text": {"en": "Thomas Frank"}, "is_correct": true}, {"id": "c", "text": {"en": "Kasper Hjulmand"}, "is_correct": false}, {"id": "d", "text": {"en": "Brian Riemer"}, "is_correct": false}]}'::jsonb),
  ('brentford', 5, 'medium', 'Who did Brentford beat in the 2021 Championship play-off final at Wembley?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Fulham"}, "is_correct": false}, {"id": "b", "text": {"en": "Barnsley"}, "is_correct": false}, {"id": "c", "text": {"en": "Swansea City"}, "is_correct": true}, {"id": "d", "text": {"en": "Bournemouth"}, "is_correct": false}]}'::jsonb),
  ('brentford', 6, 'medium', 'Which club did Brentford beat 2–0 in their first Premier League match in 2021?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Chelsea"}, "is_correct": false}, {"id": "b", "text": {"en": "Tottenham"}, "is_correct": false}, {"id": "c", "text": {"en": "Arsenal"}, "is_correct": true}, {"id": "d", "text": {"en": "West Ham"}, "is_correct": false}]}'::jsonb),
  ('brentford', 7, 'medium', 'In which part of London is Brentford based?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "East"}, "is_correct": false}, {"id": "b", "text": {"en": "North"}, "is_correct": false}, {"id": "c", "text": {"en": "South"}, "is_correct": false}, {"id": "d", "text": {"en": "West"}, "is_correct": true}]}'::jsonb),
  ('brentford', 8, 'hard', 'What is the name of Brentford’s current stadium, opened in 2020?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Gtech Community Stadium"}, "is_correct": true}, {"id": "b", "text": {"en": "The Valley"}, "is_correct": false}, {"id": "c", "text": {"en": "The Den"}, "is_correct": false}, {"id": "d", "text": {"en": "Brisbane Road"}, "is_correct": false}]}'::jsonb),
  ('brentford', 9, 'hard', 'Which striker’s penalties and England call-up made him Brentford’s talisman in the early Premier League years?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Neal Maupay"}, "is_correct": false}, {"id": "b", "text": {"en": "Ivan Toney"}, "is_correct": true}, {"id": "c", "text": {"en": "Ollie Watkins"}, "is_correct": false}, {"id": "d", "text": {"en": "Saïd Benrahma"}, "is_correct": false}]}'::jsonb),
  ('brentford', 10, 'hard', 'Brentford became famous for a recruitment model built on what?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Youth academies only"}, "is_correct": false}, {"id": "b", "text": {"en": "Data and analytics"}, "is_correct": true}, {"id": "c", "text": {"en": "Free transfers only"}, "is_correct": false}, {"id": "d", "text": {"en": "Loan signings"}, "is_correct": false}]}'::jsonb),
  ('brighton', 1, 'easy', 'What is Brighton & Hove Albion’s nickname?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Gulls"}, "is_correct": false}, {"id": "b", "text": {"en": "The Seagulls"}, "is_correct": true}, {"id": "c", "text": {"en": "The Shrimpers"}, "is_correct": false}, {"id": "d", "text": {"en": "The Pier Boys"}, "is_correct": false}]}'::jsonb),
  ('brighton', 2, 'easy', 'What is Brighton’s home stadium commonly called?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Amex"}, "is_correct": true}, {"id": "b", "text": {"en": "The Withdean"}, "is_correct": false}, {"id": "c", "text": {"en": "Goldstone Park"}, "is_correct": false}, {"id": "d", "text": {"en": "The Lanes"}, "is_correct": false}]}'::jsonb),
  ('brighton', 3, 'easy', 'Brighton reached the 1983 FA Cup final and its replay against which club?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Liverpool"}, "is_correct": false}, {"id": "b", "text": {"en": "Everton"}, "is_correct": false}, {"id": "c", "text": {"en": "Manchester United"}, "is_correct": true}, {"id": "d", "text": {"en": "Tottenham"}, "is_correct": false}]}'::jsonb),
  ('brighton', 4, 'easy', '“And Smith must score…” — did Gordon Smith score that famous last-minute chance in the 1983 final?', '{"type": "true_false", "options": [{"id": "true", "text": {"en": "Yes"}, "is_correct": false}, {"id": "false", "text": {"en": "No"}, "is_correct": true}]}'::jsonb),
  ('brighton', 5, 'medium', 'Who are Brighton’s rivals in the M23 derby?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Portsmouth"}, "is_correct": false}, {"id": "b", "text": {"en": "Southampton"}, "is_correct": false}, {"id": "c", "text": {"en": "Crystal Palace"}, "is_correct": true}, {"id": "d", "text": {"en": "Fulham"}, "is_correct": false}]}'::jsonb),
  ('brighton', 6, 'medium', 'Which poker-professional owner has bankrolled Brighton’s data-driven rise?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Tony Bloom"}, "is_correct": true}, {"id": "b", "text": {"en": "Matthew Benham"}, "is_correct": false}, {"id": "c", "text": {"en": "Daniel Levy"}, "is_correct": false}, {"id": "d", "text": {"en": "Bill Kenwright"}, "is_correct": false}]}'::jsonb),
  ('brighton', 7, 'medium', 'Under which manager did Brighton qualify for Europe for the first time in 2023?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Graham Potter"}, "is_correct": false}, {"id": "b", "text": {"en": "Chris Hughton"}, "is_correct": false}, {"id": "c", "text": {"en": "Roberto De Zerbi"}, "is_correct": true}, {"id": "d", "text": {"en": "Gus Poyet"}, "is_correct": false}]}'::jsonb),
  ('brighton', 8, 'hard', 'Whose £115m move to Chelsea in 2023 broke the British transfer record?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Marc Cucurella"}, "is_correct": false}, {"id": "b", "text": {"en": "Moisés Caicedo"}, "is_correct": true}, {"id": "c", "text": {"en": "Alexis Mac Allister"}, "is_correct": false}, {"id": "d", "text": {"en": "Yves Bissouma"}, "is_correct": false}]}'::jsonb),
  ('brighton', 9, 'hard', 'Which ground did Brighton controversially sell in 1997, nearly destroying the club?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Goldstone Ground"}, "is_correct": true}, {"id": "b", "text": {"en": "Priestfield"}, "is_correct": false}, {"id": "c", "text": {"en": "The Old Showground"}, "is_correct": false}, {"id": "d", "text": {"en": "Gigg Lane"}, "is_correct": false}]}'::jsonb),
  ('brighton', 10, 'hard', 'Which Japanese winger famously wrote a university thesis on dribbling?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Takehiro Tomiyasu"}, "is_correct": false}, {"id": "b", "text": {"en": "Kaoru Mitoma"}, "is_correct": true}, {"id": "c", "text": {"en": "Daichi Kamada"}, "is_correct": false}, {"id": "d", "text": {"en": "Wataru Endo"}, "is_correct": false}]}'::jsonb),
  ('coventry-city', 1, 'easy', 'What is Coventry City’s nickname?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Sky Blues"}, "is_correct": true}, {"id": "b", "text": {"en": "The Blues"}, "is_correct": false}, {"id": "c", "text": {"en": "The Blades"}, "is_correct": false}, {"id": "d", "text": {"en": "The Owls"}, "is_correct": false}]}'::jsonb),
  ('coventry-city', 2, 'easy', 'In which year did Coventry famously win the FA Cup?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "1985"}, "is_correct": false}, {"id": "b", "text": {"en": "1987"}, "is_correct": true}, {"id": "c", "text": {"en": "1989"}, "is_correct": false}, {"id": "d", "text": {"en": "1991"}, "is_correct": false}]}'::jsonb),
  ('coventry-city', 3, 'easy', 'Who did Coventry beat 3–2 in that FA Cup final?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Arsenal"}, "is_correct": false}, {"id": "b", "text": {"en": "Everton"}, "is_correct": false}, {"id": "c", "text": {"en": "Tottenham Hotspur"}, "is_correct": true}, {"id": "d", "text": {"en": "Liverpool"}, "is_correct": false}]}'::jsonb),
  ('coventry-city', 4, 'easy', 'Whose famous diving header helped win the 1987 final?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Cyrille Regis"}, "is_correct": false}, {"id": "b", "text": {"en": "Keith Houchen"}, "is_correct": true}, {"id": "c", "text": {"en": "Dave Bennett"}, "is_correct": false}, {"id": "d", "text": {"en": "Gary Mabbutt"}, "is_correct": false}]}'::jsonb),
  ('coventry-city', 5, 'medium', 'Which broadcaster and visionary chairman drove Coventry’s 1960s “Sky Blue Revolution”?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Jimmy Hill"}, "is_correct": true}, {"id": "b", "text": {"en": "Brian Clough"}, "is_correct": false}, {"id": "c", "text": {"en": "Bob Lord"}, "is_correct": false}, {"id": "d", "text": {"en": "Matt Busby"}, "is_correct": false}]}'::jsonb),
  ('coventry-city', 6, 'medium', 'What was Coventry’s home ground until 2005?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Highbury"}, "is_correct": false}, {"id": "b", "text": {"en": "Highfield Road"}, "is_correct": true}, {"id": "c", "text": {"en": "Filbert Street"}, "is_correct": false}, {"id": "d", "text": {"en": "The Victoria Ground"}, "is_correct": false}]}'::jsonb),
  ('coventry-city', 7, 'medium', 'Coventry’s 2001 relegation ended how many consecutive years of top-flight football?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "24"}, "is_correct": false}, {"id": "b", "text": {"en": "28"}, "is_correct": false}, {"id": "c", "text": {"en": "34"}, "is_correct": true}, {"id": "d", "text": {"en": "40"}, "is_correct": false}]}'::jsonb),
  ('coventry-city', 8, 'hard', 'Which manager rebuilt Coventry from League Two to Championship play-off contenders in the 2020s?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Mark Robins"}, "is_correct": true}, {"id": "b", "text": {"en": "Tony Mowbray"}, "is_correct": false}, {"id": "c", "text": {"en": "Steven Pressley"}, "is_correct": false}, {"id": "d", "text": {"en": "Russell Slade"}, "is_correct": false}]}'::jsonb),
  ('coventry-city', 9, 'hard', 'In which region of England is Coventry?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "East Midlands"}, "is_correct": false}, {"id": "b", "text": {"en": "West Midlands"}, "is_correct": true}, {"id": "c", "text": {"en": "North West"}, "is_correct": false}, {"id": "d", "text": {"en": "South East"}, "is_correct": false}]}'::jsonb),
  ('coventry-city', 10, 'hard', 'Coventry lost the 2023 Championship play-off final on penalties to which club?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Sheffield United"}, "is_correct": false}, {"id": "b", "text": {"en": "Middlesbrough"}, "is_correct": false}, {"id": "c", "text": {"en": "Luton Town"}, "is_correct": true}, {"id": "d", "text": {"en": "Sunderland"}, "is_correct": false}]}'::jsonb),
  ('crystal-palace', 1, 'easy', 'What is Crystal Palace’s nickname?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Eagles"}, "is_correct": true}, {"id": "b", "text": {"en": "The Owls"}, "is_correct": false}, {"id": "c", "text": {"en": "The Seagulls"}, "is_correct": false}, {"id": "d", "text": {"en": "The Hawks"}, "is_correct": false}]}'::jsonb),
  ('crystal-palace', 2, 'easy', 'What is Crystal Palace’s home ground?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Den"}, "is_correct": false}, {"id": "b", "text": {"en": "Selhurst Park"}, "is_correct": true}, {"id": "c", "text": {"en": "Plough Lane"}, "is_correct": false}, {"id": "d", "text": {"en": "Champion Hill"}, "is_correct": false}]}'::jsonb),
  ('crystal-palace', 3, 'easy', 'Palace won their first major trophy, the 2025 FA Cup, by beating which club 1–0?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Manchester United"}, "is_correct": false}, {"id": "b", "text": {"en": "Arsenal"}, "is_correct": false}, {"id": "c", "text": {"en": "Manchester City"}, "is_correct": true}, {"id": "d", "text": {"en": "Liverpool"}, "is_correct": false}]}'::jsonb),
  ('crystal-palace', 4, 'easy', 'Who scored the winning goal in that 2025 FA Cup final?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Wilfried Zaha"}, "is_correct": false}, {"id": "b", "text": {"en": "Eberechi Eze"}, "is_correct": true}, {"id": "c", "text": {"en": "Michael Olise"}, "is_correct": false}, {"id": "d", "text": {"en": "Jean-Philippe Mateta"}, "is_correct": false}]}'::jsonb),
  ('crystal-palace', 5, 'medium', 'Which academy graduate and Ivorian international became Palace’s modern talisman across two spells?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Wilfried Zaha"}, "is_correct": true}, {"id": "b", "text": {"en": "Andros Townsend"}, "is_correct": false}, {"id": "c", "text": {"en": "Jason Puncheon"}, "is_correct": false}, {"id": "d", "text": {"en": "Yannick Bolasie"}, "is_correct": false}]}'::jsonb),
  ('crystal-palace', 6, 'medium', 'Which striker did Palace sign from non-league at 21 — later an Arsenal and England legend?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Mark Bright"}, "is_correct": false}, {"id": "b", "text": {"en": "Ian Wright"}, "is_correct": true}, {"id": "c", "text": {"en": "Andy Johnson"}, "is_correct": false}, {"id": "d", "text": {"en": "Stan Collymore"}, "is_correct": false}]}'::jsonb),
  ('crystal-palace', 7, 'medium', 'What are Palace’s traditional home colours?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Red and blue stripes"}, "is_correct": true}, {"id": "b", "text": {"en": "Claret and blue"}, "is_correct": false}, {"id": "c", "text": {"en": "All white"}, "is_correct": false}, {"id": "d", "text": {"en": "Yellow and black"}, "is_correct": false}]}'::jsonb),
  ('crystal-palace', 8, 'hard', 'Who are Palace’s rivals in the M23 derby?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Millwall"}, "is_correct": false}, {"id": "b", "text": {"en": "Charlton"}, "is_correct": false}, {"id": "c", "text": {"en": "Brighton"}, "is_correct": true}, {"id": "d", "text": {"en": "Fulham"}, "is_correct": false}]}'::jsonb),
  ('crystal-palace', 9, 'hard', 'In which part of London is Selhurst Park?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "North"}, "is_correct": false}, {"id": "b", "text": {"en": "East"}, "is_correct": false}, {"id": "c", "text": {"en": "West"}, "is_correct": false}, {"id": "d", "text": {"en": "South"}, "is_correct": true}]}'::jsonb),
  ('crystal-palace', 10, 'hard', 'Palace’s 1990 FA Cup final and replay were against which club?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Everton"}, "is_correct": false}, {"id": "b", "text": {"en": "Manchester United"}, "is_correct": true}, {"id": "c", "text": {"en": "Liverpool"}, "is_correct": false}, {"id": "d", "text": {"en": "Nottingham Forest"}, "is_correct": false}]}'::jsonb),
  ('fulham', 1, 'easy', 'What is Fulham’s famous riverside home?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Craven Cottage"}, "is_correct": true}, {"id": "b", "text": {"en": "Stamford Bridge"}, "is_correct": false}, {"id": "c", "text": {"en": "Griffin Park"}, "is_correct": false}, {"id": "d", "text": {"en": "The Valley"}, "is_correct": false}]}'::jsonb),
  ('fulham', 2, 'easy', 'What is Fulham’s nickname?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Cottagers"}, "is_correct": true}, {"id": "b", "text": {"en": "The Potters"}, "is_correct": false}, {"id": "c", "text": {"en": "The Cherries"}, "is_correct": false}, {"id": "d", "text": {"en": "The Royals"}, "is_correct": false}]}'::jsonb),
  ('fulham', 3, 'easy', 'Which river runs alongside Craven Cottage?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Lea"}, "is_correct": false}, {"id": "b", "text": {"en": "The Medway"}, "is_correct": false}, {"id": "c", "text": {"en": "The Thames"}, "is_correct": true}, {"id": "d", "text": {"en": "The Wandle"}, "is_correct": false}]}'::jsonb),
  ('fulham', 4, 'easy', 'Fulham reached the 2010 Europa League final, losing to which club?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Sevilla"}, "is_correct": false}, {"id": "b", "text": {"en": "Atlético Madrid"}, "is_correct": true}, {"id": "c", "text": {"en": "Porto"}, "is_correct": false}, {"id": "d", "text": {"en": "Shakhtar Donetsk"}, "is_correct": false}]}'::jsonb),
  ('fulham', 5, 'medium', 'Who managed Fulham on that famous 2010 European run?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Roy Hodgson"}, "is_correct": true}, {"id": "b", "text": {"en": "Martin Jol"}, "is_correct": false}, {"id": "c", "text": {"en": "Mark Hughes"}, "is_correct": false}, {"id": "d", "text": {"en": "Felix Magath"}, "is_correct": false}]}'::jsonb),
  ('fulham', 6, 'medium', 'Which Fulham and England legend became the first £100-a-week footballer?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Bobby Moore"}, "is_correct": false}, {"id": "b", "text": {"en": "Johnny Haynes"}, "is_correct": true}, {"id": "c", "text": {"en": "George Cohen"}, "is_correct": false}, {"id": "d", "text": {"en": "Rodney Marsh"}, "is_correct": false}]}'::jsonb),
  ('fulham', 7, 'medium', 'Which former owner controversially put a Michael Jackson statue outside Craven Cottage?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Shahid Khan"}, "is_correct": false}, {"id": "b", "text": {"en": "Mohamed Al-Fayed"}, "is_correct": true}, {"id": "c", "text": {"en": "Roman Abramovich"}, "is_correct": false}, {"id": "d", "text": {"en": "Randy Lerner"}, "is_correct": false}]}'::jsonb),
  ('fulham', 8, 'hard', 'Fulham, founded in 1879, hold which London distinction?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Oldest professional club"}, "is_correct": true}, {"id": "b", "text": {"en": "Most stadiums used"}, "is_correct": false}, {"id": "c", "text": {"en": "First to wear white"}, "is_correct": false}, {"id": "d", "text": {"en": "First London champions"}, "is_correct": false}]}'::jsonb),
  ('fulham', 9, 'hard', 'Which American scored the famous chip against Juventus in the 2010 comeback?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Brian McBride"}, "is_correct": false}, {"id": "b", "text": {"en": "Clint Dempsey"}, "is_correct": true}, {"id": "c", "text": {"en": "Eddie Johnson"}, "is_correct": false}, {"id": "d", "text": {"en": "Carlos Bocanegra"}, "is_correct": false}]}'::jsonb),
  ('fulham', 10, 'hard', 'What is the name of the historic pavilion building in the corner of Fulham’s ground?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Cottage"}, "is_correct": true}, {"id": "b", "text": {"en": "The Lodge"}, "is_correct": false}, {"id": "c", "text": {"en": "The Boathouse"}, "is_correct": false}, {"id": "d", "text": {"en": "The Manor"}, "is_correct": false}]}'::jsonb),
  ('hull-city', 1, 'easy', 'What is Hull City’s nickname?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Tigers"}, "is_correct": true}, {"id": "b", "text": {"en": "The Lions"}, "is_correct": false}, {"id": "c", "text": {"en": "The Panthers"}, "is_correct": false}, {"id": "d", "text": {"en": "The Terriers"}, "is_correct": false}]}'::jsonb),
  ('hull-city', 2, 'easy', 'In which year did Hull City reach the top flight for the first time in their history?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "2004"}, "is_correct": false}, {"id": "b", "text": {"en": "2006"}, "is_correct": false}, {"id": "c", "text": {"en": "2008"}, "is_correct": true}, {"id": "d", "text": {"en": "2010"}, "is_correct": false}]}'::jsonb),
  ('hull-city', 3, 'easy', 'Whose long-range wonder goal won the 2008 play-off final for Hull?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Nick Barmby"}, "is_correct": false}, {"id": "b", "text": {"en": "Dean Windass"}, "is_correct": true}, {"id": "c", "text": {"en": "Fraizer Campbell"}, "is_correct": false}, {"id": "d", "text": {"en": "Ian Ashbee"}, "is_correct": false}]}'::jsonb),
  ('hull-city', 4, 'easy', 'What is Hull City’s home stadium currently called?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "MKM Stadium"}, "is_correct": true}, {"id": "b", "text": {"en": "Boothferry Park"}, "is_correct": false}, {"id": "c", "text": {"en": "The Circle"}, "is_correct": false}, {"id": "d", "text": {"en": "Craven Park"}, "is_correct": false}]}'::jsonb),
  ('hull-city', 5, 'medium', 'Hull led the 2014 FA Cup final 2–0 before losing 3–2 in extra time. Against which club?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Manchester City"}, "is_correct": false}, {"id": "b", "text": {"en": "Chelsea"}, "is_correct": false}, {"id": "c", "text": {"en": "Arsenal"}, "is_correct": true}, {"id": "d", "text": {"en": "Wigan Athletic"}, "is_correct": false}]}'::jsonb),
  ('hull-city', 6, 'medium', 'What are Hull City’s traditional colours?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Amber and black"}, "is_correct": true}, {"id": "b", "text": {"en": "Red and white"}, "is_correct": false}, {"id": "c", "text": {"en": "Blue and yellow"}, "is_correct": false}, {"id": "d", "text": {"en": "Green and white"}, "is_correct": false}]}'::jsonb),
  ('hull-city', 7, 'medium', 'Which manager famously delivered a half-time team talk on the pitch at Manchester City in 2008?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Phil Parkinson"}, "is_correct": false}, {"id": "b", "text": {"en": "Phil Brown"}, "is_correct": true}, {"id": "c", "text": {"en": "Steve Bruce"}, "is_correct": false}, {"id": "d", "text": {"en": "Nigel Adkins"}, "is_correct": false}]}'::jsonb),
  ('hull-city', 8, 'hard', 'In which part of Yorkshire is Hull located?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "West Yorkshire"}, "is_correct": false}, {"id": "b", "text": {"en": "South Yorkshire"}, "is_correct": false}, {"id": "c", "text": {"en": "North Yorkshire"}, "is_correct": false}, {"id": "d", "text": {"en": "East Yorkshire"}, "is_correct": true}]}'::jsonb),
  ('hull-city', 9, 'hard', 'In which year was Hull City founded?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "1894"}, "is_correct": false}, {"id": "b", "text": {"en": "1904"}, "is_correct": true}, {"id": "c", "text": {"en": "1914"}, "is_correct": false}, {"id": "d", "text": {"en": "1924"}, "is_correct": false}]}'::jsonb),
  ('hull-city', 10, 'hard', 'What is the city of Hull’s full formal name?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Hull-on-Humber"}, "is_correct": false}, {"id": "b", "text": {"en": "Kingston upon Hull"}, "is_correct": true}, {"id": "c", "text": {"en": "Great Hull"}, "is_correct": false}, {"id": "d", "text": {"en": "Hull St Mary"}, "is_correct": false}]}'::jsonb),
  ('ipswich-town', 1, 'easy', 'What is Ipswich Town’s nickname?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Tractor Boys"}, "is_correct": true}, {"id": "b", "text": {"en": "The Farmers"}, "is_correct": false}, {"id": "c", "text": {"en": "The Millers"}, "is_correct": false}, {"id": "d", "text": {"en": "The Cobblers"}, "is_correct": false}]}'::jsonb),
  ('ipswich-town', 2, 'easy', 'What is Ipswich Town’s home ground?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Carrow Road"}, "is_correct": false}, {"id": "b", "text": {"en": "Portman Road"}, "is_correct": true}, {"id": "c", "text": {"en": "Roots Hall"}, "is_correct": false}, {"id": "d", "text": {"en": "Layer Road"}, "is_correct": false}]}'::jsonb),
  ('ipswich-town', 3, 'easy', 'Which future England World Cup-winning manager led Ipswich to the 1961–62 league title?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Bobby Robson"}, "is_correct": false}, {"id": "b", "text": {"en": "Alf Ramsey"}, "is_correct": true}, {"id": "c", "text": {"en": "Walter Winterbottom"}, "is_correct": false}, {"id": "d", "text": {"en": "Don Revie"}, "is_correct": false}]}'::jsonb),
  ('ipswich-town', 4, 'easy', 'Under which manager did Ipswich win the 1981 UEFA Cup?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Bobby Robson"}, "is_correct": true}, {"id": "b", "text": {"en": "Bill McGarry"}, "is_correct": false}, {"id": "c", "text": {"en": "John Lyall"}, "is_correct": false}, {"id": "d", "text": {"en": "George Burley"}, "is_correct": false}]}'::jsonb),
  ('ipswich-town', 5, 'medium', 'Ipswich won the 1978 FA Cup final 1–0 against which club?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Liverpool"}, "is_correct": false}, {"id": "b", "text": {"en": "Manchester United"}, "is_correct": false}, {"id": "c", "text": {"en": "Arsenal"}, "is_correct": true}, {"id": "d", "text": {"en": "West Ham"}, "is_correct": false}]}'::jsonb),
  ('ipswich-town', 6, 'medium', 'In which English county is Ipswich?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Norfolk"}, "is_correct": false}, {"id": "b", "text": {"en": "Essex"}, "is_correct": false}, {"id": "c", "text": {"en": "Suffolk"}, "is_correct": true}, {"id": "d", "text": {"en": "Cambridgeshire"}, "is_correct": false}]}'::jsonb),
  ('ipswich-town', 7, 'medium', 'Which manager took Ipswich from League One to the Premier League in back-to-back seasons (2023 and 2024)?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Kieran McKenna"}, "is_correct": true}, {"id": "b", "text": {"en": "Paul Cook"}, "is_correct": false}, {"id": "c", "text": {"en": "Mick McCarthy"}, "is_correct": false}, {"id": "d", "text": {"en": "Paul Lambert"}, "is_correct": false}]}'::jsonb),
  ('ipswich-town', 8, 'hard', 'Which Scottish midfielder scored 14 goals in Ipswich’s 1980–81 UEFA Cup campaign?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "John Wark"}, "is_correct": true}, {"id": "b", "text": {"en": "Alan Brazil"}, "is_correct": false}, {"id": "c", "text": {"en": "George Burley"}, "is_correct": false}, {"id": "d", "text": {"en": "Eric Gates"}, "is_correct": false}]}'::jsonb),
  ('ipswich-town', 9, 'hard', 'Who are Ipswich’s rivals in the “Old Farm” derby?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Colchester United"}, "is_correct": false}, {"id": "b", "text": {"en": "Norwich City"}, "is_correct": true}, {"id": "c", "text": {"en": "Cambridge United"}, "is_correct": false}, {"id": "d", "text": {"en": "Southend"}, "is_correct": false}]}'::jsonb),
  ('ipswich-town', 10, 'hard', 'Who did Ipswich beat over two legs in the 1981 UEFA Cup final?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "AZ Alkmaar"}, "is_correct": true}, {"id": "b", "text": {"en": "Ajax"}, "is_correct": false}, {"id": "c", "text": {"en": "Feyenoord"}, "is_correct": false}, {"id": "d", "text": {"en": "PSV"}, "is_correct": false}]}'::jsonb),
  ('leeds-united', 1, 'easy', 'What is Leeds United’s home ground?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Elland Road"}, "is_correct": true}, {"id": "b", "text": {"en": "Valley Parade"}, "is_correct": false}, {"id": "c", "text": {"en": "Hillsborough"}, "is_correct": false}, {"id": "d", "text": {"en": "Oakwell"}, "is_correct": false}]}'::jsonb),
  ('leeds-united', 2, 'easy', 'Leeds were the last champions of the old First Division before the Premier League began. In which year?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "1990"}, "is_correct": false}, {"id": "b", "text": {"en": "1991"}, "is_correct": false}, {"id": "c", "text": {"en": "1992"}, "is_correct": true}, {"id": "d", "text": {"en": "1993"}, "is_correct": false}]}'::jsonb),
  ('leeds-united', 3, 'easy', 'Which legendary manager built the great Leeds side of the 1960s and 70s?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Brian Clough"}, "is_correct": false}, {"id": "b", "text": {"en": "Don Revie"}, "is_correct": true}, {"id": "c", "text": {"en": "Howard Wilkinson"}, "is_correct": false}, {"id": "d", "text": {"en": "Jimmy Armfield"}, "is_correct": false}]}'::jsonb),
  ('leeds-united', 4, 'easy', 'Which Argentine manager ended Leeds’ 16-year top-flight exile in 2020?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Mauricio Pochettino"}, "is_correct": false}, {"id": "b", "text": {"en": "Marcelo Bielsa"}, "is_correct": true}, {"id": "c", "text": {"en": "Diego Simeone"}, "is_correct": false}, {"id": "d", "text": {"en": "Mauricio Pellegrino"}, "is_correct": false}]}'::jsonb),
  ('leeds-united', 5, 'medium', 'Whose statue, arms aloft, stands outside Elland Road?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Jack Charlton"}, "is_correct": false}, {"id": "b", "text": {"en": "Norman Hunter"}, "is_correct": false}, {"id": "c", "text": {"en": "Billy Bremner"}, "is_correct": true}, {"id": "d", "text": {"en": "Peter Lorimer"}, "is_correct": false}]}'::jsonb),
  ('leeds-united', 6, 'medium', 'Which Frenchman did Leeds famously sell to Manchester United in 1992?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "David Ginola"}, "is_correct": false}, {"id": "b", "text": {"en": "Éric Cantona"}, "is_correct": true}, {"id": "c", "text": {"en": "Franck Sauzée"}, "is_correct": false}, {"id": "d", "text": {"en": "Laurent Blanc"}, "is_correct": false}]}'::jsonb),
  ('leeds-united', 7, 'medium', 'In 2000–01, Leeds reached the semi-finals of which competition?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "UEFA Cup"}, "is_correct": false}, {"id": "b", "text": {"en": "Cup Winners’ Cup"}, "is_correct": false}, {"id": "c", "text": {"en": "Champions League"}, "is_correct": true}, {"id": "d", "text": {"en": "Intertoto Cup"}, "is_correct": false}]}'::jsonb),
  ('leeds-united', 8, 'hard', 'Which South African centre-back and captain was nicknamed “The Chief”?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Lucas Radebe"}, "is_correct": true}, {"id": "b", "text": {"en": "Phil Masinga"}, "is_correct": false}, {"id": "c", "text": {"en": "Albert Johanneson"}, "is_correct": false}, {"id": "d", "text": {"en": "Rio Ferdinand"}, "is_correct": false}]}'::jsonb),
  ('leeds-united', 9, 'hard', 'Which county emblem is associated with Leeds United?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Red rose of Lancashire"}, "is_correct": false}, {"id": "b", "text": {"en": "White rose of Yorkshire"}, "is_correct": true}, {"id": "c", "text": {"en": "Three lions"}, "is_correct": false}, {"id": "d", "text": {"en": "Oak leaf"}, "is_correct": false}]}'::jsonb),
  ('leeds-united', 10, 'hard', 'Which German manager led Leeds to the 2024–25 Championship title and promotion?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Jürgen Klopp"}, "is_correct": false}, {"id": "b", "text": {"en": "Daniel Farke"}, "is_correct": true}, {"id": "c", "text": {"en": "David Wagner"}, "is_correct": false}, {"id": "d", "text": {"en": "Jesse Marsch"}, "is_correct": false}]}'::jsonb),
  ('newcastle-united', 1, 'easy', 'What is Newcastle United’s nickname?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Magpies"}, "is_correct": true}, {"id": "b", "text": {"en": "The Canaries"}, "is_correct": false}, {"id": "c", "text": {"en": "The Robins"}, "is_correct": false}, {"id": "d", "text": {"en": "The Swans"}, "is_correct": false}]}'::jsonb),
  ('newcastle-united', 2, 'easy', 'What is Newcastle’s famous home ground?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Roker Park"}, "is_correct": false}, {"id": "b", "text": {"en": "St James’ Park"}, "is_correct": true}, {"id": "c", "text": {"en": "Ayresome Park"}, "is_correct": false}, {"id": "d", "text": {"en": "Gallowgate Arena"}, "is_correct": false}]}'::jsonb),
  ('newcastle-united', 3, 'easy', 'Who is Newcastle’s all-time record goalscorer with 206 goals?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Jackie Milburn"}, "is_correct": false}, {"id": "b", "text": {"en": "Malcolm Macdonald"}, "is_correct": false}, {"id": "c", "text": {"en": "Alan Shearer"}, "is_correct": true}, {"id": "d", "text": {"en": "Les Ferdinand"}, "is_correct": false}]}'::jsonb),
  ('newcastle-united', 4, 'easy', 'Newcastle’s 2025 League Cup final win — their first domestic trophy in 70 years — came against which club?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Arsenal"}, "is_correct": false}, {"id": "b", "text": {"en": "Manchester City"}, "is_correct": false}, {"id": "c", "text": {"en": "Chelsea"}, "is_correct": false}, {"id": "d", "text": {"en": "Liverpool"}, "is_correct": true}]}'::jsonb),
  ('newcastle-united', 5, 'medium', 'Which manager led the beloved mid-90s side known as “The Entertainers”?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Kenny Dalglish"}, "is_correct": false}, {"id": "b", "text": {"en": "Kevin Keegan"}, "is_correct": true}, {"id": "c", "text": {"en": "Bobby Robson"}, "is_correct": false}, {"id": "d", "text": {"en": "Ruud Gullit"}, "is_correct": false}]}'::jsonb),
  ('newcastle-united', 6, 'medium', 'What are Newcastle’s traditional home colours?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Red and white stripes"}, "is_correct": false}, {"id": "b", "text": {"en": "Black and white stripes"}, "is_correct": true}, {"id": "c", "text": {"en": "Blue and white stripes"}, "is_correct": false}, {"id": "d", "text": {"en": "All black"}, "is_correct": false}]}'::jsonb),
  ('newcastle-united', 7, 'medium', 'Which consortium completed a takeover of Newcastle in 2021?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "A Saudi-led consortium (PIF)"}, "is_correct": true}, {"id": "b", "text": {"en": "A US hedge fund"}, "is_correct": false}, {"id": "c", "text": {"en": "A Chinese group"}, "is_correct": false}, {"id": "d", "text": {"en": "A Qatari fund"}, "is_correct": false}]}'::jsonb),
  ('newcastle-united', 8, 'hard', 'Who are Newcastle’s rivals in the Tyne–Wear derby?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Middlesbrough"}, "is_correct": false}, {"id": "b", "text": {"en": "Sunderland"}, "is_correct": true}, {"id": "c", "text": {"en": "Leeds United"}, "is_correct": false}, {"id": "d", "text": {"en": "Carlisle"}, "is_correct": false}]}'::jsonb),
  ('newcastle-united', 9, 'hard', 'Which European trophy did Newcastle win in 1969?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "European Cup"}, "is_correct": false}, {"id": "b", "text": {"en": "Cup Winners’ Cup"}, "is_correct": false}, {"id": "c", "text": {"en": "Inter-Cities Fairs Cup"}, "is_correct": true}, {"id": "d", "text": {"en": "Super Cup"}, "is_correct": false}]}'::jsonb),
  ('newcastle-united', 10, 'hard', 'Kevin Keegan’s famous “I would love it if we beat them” outburst was aimed at which rival manager?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Arsène Wenger"}, "is_correct": false}, {"id": "b", "text": {"en": "Alex Ferguson"}, "is_correct": true}, {"id": "c", "text": {"en": "George Graham"}, "is_correct": false}, {"id": "d", "text": {"en": "Roy Evans"}, "is_correct": false}]}'::jsonb),
  ('nottingham-forest', 1, 'easy', 'How many European Cups did Nottingham Forest win?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "One"}, "is_correct": false}, {"id": "b", "text": {"en": "Two"}, "is_correct": true}, {"id": "c", "text": {"en": "Three"}, "is_correct": false}, {"id": "d", "text": {"en": "Four"}, "is_correct": false}]}'::jsonb),
  ('nottingham-forest', 2, 'easy', 'Which legendary manager led Forest to those triumphs in 1979 and 1980?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Don Revie"}, "is_correct": false}, {"id": "b", "text": {"en": "Bob Paisley"}, "is_correct": false}, {"id": "c", "text": {"en": "Brian Clough"}, "is_correct": true}, {"id": "d", "text": {"en": "Ron Atkinson"}, "is_correct": false}]}'::jsonb),
  ('nottingham-forest', 3, 'easy', 'What is Forest’s home ground?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Meadow Lane"}, "is_correct": false}, {"id": "b", "text": {"en": "The City Ground"}, "is_correct": true}, {"id": "c", "text": {"en": "Pride Park"}, "is_correct": false}, {"id": "d", "text": {"en": "Trentside Arena"}, "is_correct": false}]}'::jsonb),
  ('nottingham-forest', 4, 'easy', 'On the banks of which river does the City Ground sit?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Severn"}, "is_correct": false}, {"id": "b", "text": {"en": "Ouse"}, "is_correct": false}, {"id": "c", "text": {"en": "Trent"}, "is_correct": true}, {"id": "d", "text": {"en": "Soar"}, "is_correct": false}]}'::jsonb),
  ('nottingham-forest', 5, 'medium', 'Who scored the winner in the 1979 European Cup final against Malmö?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "John Robertson"}, "is_correct": false}, {"id": "b", "text": {"en": "Trevor Francis"}, "is_correct": true}, {"id": "c", "text": {"en": "Garry Birtles"}, "is_correct": false}, {"id": "d", "text": {"en": "Tony Woodcock"}, "is_correct": false}]}'::jsonb),
  ('nottingham-forest', 6, 'medium', 'Trevor Francis made history when Forest signed him in 1979. Why?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "First £1m British transfer"}, "is_correct": true}, {"id": "b", "text": {"en": "Youngest ever signing"}, "is_correct": false}, {"id": "c", "text": {"en": "First foreign signing"}, "is_correct": false}, {"id": "d", "text": {"en": "First free transfer"}, "is_correct": false}]}'::jsonb),
  ('nottingham-forest', 7, 'medium', 'Which Forest and England defender was nicknamed “Psycho”?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Des Walker"}, "is_correct": false}, {"id": "b", "text": {"en": "Stuart Pearce"}, "is_correct": true}, {"id": "c", "text": {"en": "Colin Cooper"}, "is_correct": false}, {"id": "d", "text": {"en": "Steve Chettle"}, "is_correct": false}]}'::jsonb),
  ('nottingham-forest', 8, 'hard', 'Forest won the league title in 1977–78 — remarkably, in their first season after what?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Relegation"}, "is_correct": false}, {"id": "b", "text": {"en": "Promotion"}, "is_correct": true}, {"id": "c", "text": {"en": "Administration"}, "is_correct": false}, {"id": "d", "text": {"en": "A points deduction"}, "is_correct": false}]}'::jsonb),
  ('nottingham-forest', 9, 'hard', 'Who are Forest’s fierce East Midlands rivals?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Leicester City"}, "is_correct": false}, {"id": "b", "text": {"en": "Notts County"}, "is_correct": false}, {"id": "c", "text": {"en": "Derby County"}, "is_correct": true}, {"id": "d", "text": {"en": "Lincoln City"}, "is_correct": false}]}'::jsonb),
  ('nottingham-forest', 10, 'hard', 'Who scored the only goal of the 1980 European Cup final against Hamburg?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "John Robertson"}, "is_correct": true}, {"id": "b", "text": {"en": "Martin O’Neill"}, "is_correct": false}, {"id": "c", "text": {"en": "Kenny Burns"}, "is_correct": false}, {"id": "d", "text": {"en": "Ian Bowyer"}, "is_correct": false}]}'::jsonb),
  ('sunderland', 1, 'easy', 'What is Sunderland’s nickname?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Black Cats"}, "is_correct": true}, {"id": "b", "text": {"en": "The Magpies"}, "is_correct": false}, {"id": "c", "text": {"en": "The Terriers"}, "is_correct": false}, {"id": "d", "text": {"en": "The Baggies"}, "is_correct": false}]}'::jsonb),
  ('sunderland', 2, 'easy', 'What is the name of Sunderland’s home stadium, opened in 1997?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Stadium of Light"}, "is_correct": true}, {"id": "b", "text": {"en": "Roker Park"}, "is_correct": false}, {"id": "c", "text": {"en": "Light Park"}, "is_correct": false}, {"id": "d", "text": {"en": "Wearmouth Arena"}, "is_correct": false}]}'::jsonb),
  ('sunderland', 3, 'easy', 'What was Sunderland’s famous home ground before 1997?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Ayresome Park"}, "is_correct": false}, {"id": "b", "text": {"en": "Roker Park"}, "is_correct": true}, {"id": "c", "text": {"en": "Feethams"}, "is_correct": false}, {"id": "d", "text": {"en": "Brunton Park"}, "is_correct": false}]}'::jsonb),
  ('sunderland', 4, 'easy', 'Second Division Sunderland shocked which club to win the 1973 FA Cup final?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Arsenal"}, "is_correct": false}, {"id": "b", "text": {"en": "Liverpool"}, "is_correct": false}, {"id": "c", "text": {"en": "Leeds United"}, "is_correct": true}, {"id": "d", "text": {"en": "Manchester City"}, "is_correct": false}]}'::jsonb),
  ('sunderland', 5, 'medium', 'Whose legendary double save kept Sunderland ahead in that 1973 final?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Jim Montgomery"}, "is_correct": true}, {"id": "b", "text": {"en": "Peter Shilton"}, "is_correct": false}, {"id": "c", "text": {"en": "Gordon Banks"}, "is_correct": false}, {"id": "d", "text": {"en": "Pat Jennings"}, "is_correct": false}]}'::jsonb),
  ('sunderland', 6, 'medium', 'Which Sunderland striker won the European Golden Shoe with 30 Premier League goals in 1999–2000?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Niall Quinn"}, "is_correct": false}, {"id": "b", "text": {"en": "Kevin Phillips"}, "is_correct": true}, {"id": "c", "text": {"en": "Marco Gabbiadini"}, "is_correct": false}, {"id": "d", "text": {"en": "Darren Bent"}, "is_correct": false}]}'::jsonb),
  ('sunderland', 7, 'medium', 'Who are Sunderland’s fierce derby rivals?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Middlesbrough"}, "is_correct": false}, {"id": "b", "text": {"en": "Leeds United"}, "is_correct": false}, {"id": "c", "text": {"en": "Newcastle United"}, "is_correct": true}, {"id": "d", "text": {"en": "Hartlepool"}, "is_correct": false}]}'::jsonb),
  ('sunderland', 8, 'hard', 'What was the name of the Netflix documentary series about the club?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "The Black Cats Rise"}, "is_correct": false}, {"id": "b", "text": {"en": "Sunderland ’Til I Die"}, "is_correct": true}, {"id": "c", "text": {"en": "Roker Roar"}, "is_correct": false}, {"id": "d", "text": {"en": "Wearside Story"}, "is_correct": false}]}'::jsonb),
  ('sunderland', 9, 'hard', 'Sunderland won the 2025 Championship play-off final at Wembley against which club?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Sheffield United"}, "is_correct": true}, {"id": "b", "text": {"en": "Leeds United"}, "is_correct": false}, {"id": "c", "text": {"en": "Coventry City"}, "is_correct": false}, {"id": "d", "text": {"en": "West Brom"}, "is_correct": false}]}'::jsonb),
  ('sunderland', 10, 'hard', 'On which river does Sunderland sit?', '{"type": "mcq_single", "options": [{"id": "a", "text": {"en": "Tyne"}, "is_correct": false}, {"id": "b", "text": {"en": "Tees"}, "is_correct": false}, {"id": "c", "text": {"en": "Wear"}, "is_correct": true}, {"id": "d", "text": {"en": "Humber"}, "is_correct": false}]}'::jsonb);

-- Store document questions in the central bank, but mark them public-only from
-- birth so no deployment window can expose them to ranked matchmaking.
INSERT INTO public.questions (
  category_id,
  type,
  difficulty,
  status,
  prompt,
  explanation,
  ranked_eligible,
  visibility
)
SELECT
  category.id,
  source.payload->>'type',
  source.difficulty,
  'published',
  jsonb_build_object('en', source.prompt),
  NULL,
  FALSE,
  'public'
FROM manual_campaign_questions source
JOIN public.categories category ON category.slug = source.quiz_slug
WHERE NOT EXISTS (
  SELECT 1
  FROM public.questions existing
  WHERE existing.category_id = category.id
    AND existing.prompt->>'en' = source.prompt
);

INSERT INTO public.question_payloads (question_id, payload)
SELECT question.id, source.payload
FROM manual_campaign_questions source
JOIN public.categories category ON category.slug = source.quiz_slug
JOIN public.questions question
  ON question.category_id = category.id
 AND question.prompt->>'en' = source.prompt
WHERE NOT EXISTS (
  SELECT 1 FROM public.question_payloads existing WHERE existing.question_id = question.id
);

INSERT INTO public.campaign_quiz_questions (
  quiz_slug,
  question_id,
  difficulty,
  display_order
)
SELECT source.quiz_slug, question.id, source.difficulty, source.display_order
FROM manual_campaign_questions source
JOIN public.categories category ON category.slug = source.quiz_slug
JOIN public.questions question
  ON question.category_id = category.id
 AND question.prompt->>'en' = source.prompt
ON CONFLICT DO NOTHING;

-- Curate 5 easy, 5 medium and 5 hard questions from the existing category
-- banks. Ranking is deterministic and each question can belong to one public
-- campaign only.
CREATE TEMP TABLE existing_category_campaigns (
  quiz_slug TEXT PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO existing_category_campaigns (quiz_slug)
VALUES ('arsenal'), ('chelsea'), ('manchester-city');

CREATE TEMP TABLE existing_category_candidates ON COMMIT DROP AS
WITH candidates AS (
  SELECT
    configured.quiz_slug,
    question.id AS question_id,
    question.difficulty AS source_difficulty,
    ROW_NUMBER() OVER (
      PARTITION BY configured.quiz_slug, regexp_replace(lower(question.prompt->>'en'), '[^a-z0-9]', '', 'g')
      ORDER BY md5(question.id::text || configured.quiz_slug)
    ) AS duplicate_rank
  FROM existing_category_campaigns configured
  JOIN public.categories category ON category.slug = configured.quiz_slug
  JOIN public.questions question ON question.category_id = category.id
  JOIN public.question_payloads payload ON payload.question_id = question.id
  WHERE question.status = 'published'
    AND question.visibility = 'public'
    AND question.ranked_eligible = TRUE
    AND question.type IN ('mcq_single', 'true_false')
    AND COALESCE(question.prompt->>'en', '') <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM public.campaign_quiz_questions assigned
      WHERE assigned.question_id = question.id
    )
)
SELECT quiz_slug, question_id, source_difficulty
FROM candidates
WHERE duplicate_rank = 1;

WITH ranked AS (
  SELECT
    candidate.*,
    ROW_NUMBER() OVER (
      PARTITION BY candidate.quiz_slug
      ORDER BY CASE candidate.source_difficulty WHEN 'easy' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
               md5(candidate.question_id::text || candidate.quiz_slug)
    ) AS selection_order
  FROM existing_category_candidates candidate
  WHERE candidate.source_difficulty = 'easy'
)
INSERT INTO public.campaign_quiz_questions (quiz_slug, question_id, difficulty, display_order)
SELECT quiz_slug, question_id, source_difficulty, selection_order
FROM ranked
WHERE selection_order <= 5
ON CONFLICT DO NOTHING;

WITH remaining AS (
  SELECT candidate.*
  FROM existing_category_candidates candidate
  WHERE NOT EXISTS (
    SELECT 1 FROM public.campaign_quiz_questions assigned WHERE assigned.question_id = candidate.question_id
  )
), ranked AS (
  SELECT
    remaining.*,
    ROW_NUMBER() OVER (
      PARTITION BY remaining.quiz_slug
      ORDER BY CASE remaining.source_difficulty WHEN 'medium' THEN 0 WHEN 'hard' THEN 1 ELSE 2 END,
               md5(remaining.question_id::text || remaining.quiz_slug)
    ) AS selection_order
  FROM remaining
  WHERE remaining.source_difficulty = 'medium'
)
INSERT INTO public.campaign_quiz_questions (quiz_slug, question_id, difficulty, display_order)
SELECT quiz_slug, question_id, source_difficulty, 5 + selection_order
FROM ranked
WHERE selection_order <= 5
ON CONFLICT DO NOTHING;

WITH remaining AS (
  SELECT candidate.*
  FROM existing_category_candidates candidate
  WHERE NOT EXISTS (
    SELECT 1 FROM public.campaign_quiz_questions assigned WHERE assigned.question_id = candidate.question_id
  )
), ranked AS (
  SELECT
    remaining.*,
    ROW_NUMBER() OVER (
      PARTITION BY remaining.quiz_slug
      ORDER BY CASE remaining.source_difficulty WHEN 'hard' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
               md5(remaining.question_id::text || remaining.quiz_slug)
    ) AS selection_order
  FROM remaining
  WHERE remaining.source_difficulty = 'hard'
)
INSERT INTO public.campaign_quiz_questions (quiz_slug, question_id, difficulty, display_order)
SELECT quiz_slug, question_id, source_difficulty, 10 + selection_order
FROM ranked
WHERE selection_order <= 5
ON CONFLICT DO NOTHING;

UPDATE public.questions question
SET ranked_eligible = FALSE,
    updated_at = NOW()
WHERE EXISTS (
  SELECT 1
  FROM public.campaign_quiz_questions assigned
  WHERE assigned.question_id = question.id
    AND assigned.quiz_slug IN ('arsenal', 'aston-villa', 'bournemouth', 'brentford', 'brighton', 'chelsea', 'coventry-city', 'crystal-palace', 'fulham', 'hull-city', 'ipswich-town', 'leeds-united', 'manchester-city', 'newcastle-united', 'nottingham-forest', 'sunderland')
);

-- Surface accidental ranked-pool depletion during deployment. Campaign
-- extraction is intentional, but each established category should retain a
-- usable ranked bank after its 15 public-only questions are reserved.
DO $$
DECLARE
  pool RECORD;
BEGIN
  FOR pool IN
    SELECT category.slug,
           COUNT(question.id) FILTER (
             WHERE question.status = 'published'
               AND question.visibility = 'public'
               AND question.ranked_eligible = TRUE
           )::int AS ranked_remaining
    FROM public.categories category
    LEFT JOIN public.questions question ON question.category_id = category.id
    WHERE category.slug IN ('arsenal', 'chelsea', 'manchester-city')
    GROUP BY category.slug
  LOOP
    IF pool.ranked_remaining < 15 THEN
      RAISE WARNING 'Campaign extraction left only % ranked-eligible questions for category %',
        pool.ranked_remaining, pool.slug;
    END IF;
  END LOOP;
END $$;

-- The document-backed pools publish with exactly ten supplied questions. The
-- three established category pools publish only when their 5/5/5 mix is full.
UPDATE public.campaign_quizzes quiz
SET status = CASE
      WHEN quiz.slug IN ('arsenal', 'chelsea', 'manchester-city') AND pool.total = 15 THEN 'published'
      WHEN quiz.slug NOT IN ('arsenal', 'chelsea', 'manchester-city') AND pool.total = 10 THEN 'published'
      ELSE 'draft'
    END,
    updated_at = NOW()
FROM (
  SELECT configured.quiz_slug, COUNT(assigned.question_id)::int AS total
  FROM (VALUES
    ('arsenal'), ('aston-villa'), ('bournemouth'), ('brentford'),
    ('brighton'), ('chelsea'), ('coventry-city'), ('crystal-palace'),
    ('fulham'), ('hull-city'), ('ipswich-town'), ('leeds-united'),
    ('manchester-city'), ('newcastle-united'), ('nottingham-forest'), ('sunderland')
  ) configured(quiz_slug)
  LEFT JOIN public.campaign_quiz_questions assigned
    ON assigned.quiz_slug = configured.quiz_slug
  GROUP BY configured.quiz_slug
) pool
WHERE quiz.slug = pool.quiz_slug;
