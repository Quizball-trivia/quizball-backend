import type { ChoreographyContent } from '../../src/modules/guess-the-goal/guess-the-goal.schemas.js';

/** Hand-authored seed choreographies, part 2: modern era + Georgian moments. */

const t = (en: string, ka: string) => ({ en, ka });
const opt = (id: string, en: string, ka: string, correct = false) => ({
  id,
  text: t(en, ka),
  is_correct: correct,
});

export const MODERN_GOALS: ChoreographyContent[] = [
  {
    slug: 'maxi-rodriguez-mexico-2006',
    difficulty: 'hard',
    title: t(
      'Maxi Rodríguez — Argentina vs Mexico, 2006 World Cup (chest & volley)',
      'მაქსი როდრიგესი — არგენტინა მექსიკასთან, 2006 მუნდიალი (მკერდი და ვოლეი)'
    ),
    options: [
      opt('a', 'Maxi Rodríguez — Argentina vs Mexico, 2006', 'მაქსი როდრიგესი — არგენტინა მექსიკასთან, 2006', true),
      opt('b', 'James Rodríguez — Colombia vs Uruguay, 2014', 'ხამეს როდრიგესი — კოლუმბია ურუგვაისთან, 2014'),
      opt('c', 'Michael Essien — Chelsea vs Arsenal, 2006', 'მაიკლ ესიენი — ჩელსი არსენალთან, 2006'),
      opt('d', "Paul Scholes — Man United vs Aston Villa, 2006", 'პოლ სქოულზი — მან. იუნაიტედი ასტონ ვილასთან, 2006'),
    ],
    fun_fact: t(
      'Extra time in Leipzig: a long diagonal dropped on his chest at the corner of the box and the left-foot volley screamed into the far top corner.',
      'დამატებითი დრო ლაიფციგში: გრძელი დიაგონალი მკერდზე დაივარდა და მარცხენა ფეხის ვოლეი შორეულ ზედა კუთხეში შეიჭრა.'
    ),
    bonus: {
      question: t('What stage of the 2006 World Cup was this?', '2006 მუნდიალის რომელი ეტაპი იყო?'),
      options: [
        opt('a', 'Round of 16', '1/8 ფინალი', true),
        opt('b', 'Group stage', 'ჯგუფური ეტაპი'),
        opt('c', 'Quarter-final', 'მეოთხედფინალი'),
        opt('d', 'Semi-final', 'ნახევარფინალი'),
      ],
    },
    players: [
      { id: 'sorin', team: 'attack', at: [16, 66] },
      { id: 'maxi', team: 'attack', at: [50, 78] },
      { id: 'crespo', team: 'attack', at: [34, 88] },
      { id: 'd1', team: 'defense', at: [30, 82] },
      { id: 'd2', team: 'defense', at: [40, 90] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'pass', player: 'sorin', to: [47, 84], via: [32, 80], loft: 1, duration: 2.0 },
      { kind: 'run', player: 'maxi', to: [47, 84], withPrev: true, duration: 1.7 },
      { kind: 'shot', player: 'maxi', to: [30, 104], loft: 0.6, duration: 1.3 },
    ],
    scorer: 'Maxi Rodríguez',
    match_label: 'Argentina vs Mexico, World Cup round of 16',
    year: 2006,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'van-persie-spain-2014',
    difficulty: 'easy',
    title: t(
      'Robin van Persie — Netherlands vs Spain, 2014 World Cup (the Flying Dutchman)',
      'რობინ ვან პერსი — ნიდერლანდები ესპანეთთან, 2014 მუნდიალი ("მფრინავი ჰოლანდიელი")'
    ),
    options: [
      opt('a', 'Robin van Persie — Netherlands vs Spain, 2014', 'რობინ ვან პერსი — ნიდერლანდები ესპანეთთან, 2014', true),
      opt('b', 'Dennis Bergkamp — Netherlands vs Argentina, 1998', 'დენის ბერგკამპი — ნიდერლანდები არგენტინასთან, 1998'),
      opt('c', 'Keith Houchen — Coventry vs Tottenham, 1987', 'კით ჰაუჩენი — კოვენტრი ტოტენჰემთან, 1987'),
      opt('d', 'Robin van Persie — Arsenal vs Charlton, 2006', 'რობინ ვან პერსი — არსენალი ჩარლტონთან, 2006'),
    ],
    fun_fact: t(
      "Blind's 50-metre diagonal, a full-stretch flying header over Casillas from the edge of the box — the goal that ignited a 5-1 revenge of the 2010 final.",
      'ბლინდის 50-მეტრიანი დიაგონალი და კასილიასზე გადაფრენილი თავით დარტყმა ჯარიმის მოედნის კიდიდან — 5:1-იანი რევანშის დასაწყისი.'
    ),
    bonus: {
      question: t('Who hit the long diagonal to Van Persie?', 'ვინ გააწოდა გრძელი დიაგონალი ვან პერსისთვის?'),
      options: [
        opt('a', 'Daley Blind', 'დეილი ბლინდი', true),
        opt('b', 'Wesley Sneijder', 'უესლი სნაიდერი'),
        opt('c', 'Arjen Robben', 'არიენ რობენი'),
        opt('d', 'Nigel de Jong', 'ნაიჯელ დე იონგი'),
      ],
    },
    players: [
      { id: 'blind', team: 'attack', at: [12, 52] },
      { id: 'rvp', team: 'attack', at: [30, 76] },
      { id: 'robben', team: 'attack', at: [52, 80] },
      { id: 'ramos', team: 'defense', at: [38, 84] },
      { id: 'pique', team: 'defense', at: [28, 88] },
      { id: 'gk', team: 'keeper', at: [34, 99] },
    ],
    steps: [
      { kind: 'carry', player: 'blind', to: [14, 58], duration: 1.0 },
      { kind: 'pass', player: 'blind', to: [37, 89], via: [24, 78], loft: 1, duration: 1.8 },
      { kind: 'run', player: 'rvp', to: [37, 88], withPrev: true, duration: 1.6 },
      { kind: 'shot', player: 'rvp', to: [35, 104], loft: 0.9, duration: 0.9 },
    ],
    scorer: 'Robin van Persie',
    match_label: 'Netherlands vs Spain, World Cup group stage',
    year: 2014,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'james-rodriguez-uruguay-2014',
    difficulty: 'medium',
    title: t(
      'James Rodríguez — Colombia vs Uruguay, 2014 World Cup (chest & volley)',
      'ხამეს როდრიგესი — კოლუმბია ურუგვაისთან, 2014 მუნდიალი (მკერდი და ვოლეი)'
    ),
    options: [
      opt('a', 'James Rodríguez — Colombia vs Uruguay, 2014', 'ხამეს როდრიგესი — კოლუმბია ურუგვაისთან, 2014', true),
      opt('b', 'Maxi Rodríguez — Argentina vs Mexico, 2006', 'მაქსი როდრიგესი — არგენტინა მექსიკასთან, 2006'),
      opt('c', "Zinedine Zidane — Real Madrid vs Leverkusen, 2002", 'ზინედინ ზიდანი — რეალი ლევერკუზენთან, 2002'),
      opt('d', 'Mario Mandžukić — Croatia vs France, 2018 final', 'მარიო მანჯუკიჩი — ხორვატია საფრანგეთთან, 2018 ფინალი'),
    ],
    fun_fact: t(
      'Chested it down 25 yards out with his back half-turned, swivelled, and looped a left-foot volley in off the bar — the Puskás winner and the World Cup Golden Boot.',
      '25 იარდზე ზურგშექცევით მკერდით დაიმორჩილა, შეტრიალდა და მარცხენათი ძელქვეშ ჩააწვინა — "პუშკაშის" ჯილდო და მუნდიალის ოქროს ბუცი.'
    ),
    bonus: {
      question: t('What award did this goal win?', 'რომელი ჯილდო მოუტანა ამ გოლმა?'),
      options: [
        opt('a', 'FIFA Puskás Award', 'ФИФА "პუშკაშის" ჯილდო', true),
        opt('b', "Ballon d'Or", '"ოქროს ბურთი"'),
        opt('c', 'Golden Glove', 'ოქროს ხელთათმანი'),
        opt('d', 'Nothing — it was disallowed', 'არაფერი — გოლი გაუქმდა'),
      ],
    },
    players: [
      { id: 'cuadrado', team: 'attack', at: [28, 74] },
      { id: 'james', team: 'attack', at: [36, 78] },
      { id: 'd1', team: 'defense', at: [30, 84] },
      { id: 'd2', team: 'defense', at: [40, 86] },
      { id: 'gk', team: 'keeper', at: [34, 101] },
    ],
    steps: [
      { kind: 'pass', player: 'cuadrado', to: [36, 79], loft: 0.6, duration: 1.3 },
      { kind: 'carry', player: 'james', to: [35, 81], duration: 1.0 },
      { kind: 'shot', player: 'james', to: [34, 105], loft: 0.8, duration: 1.2 },
    ],
    scorer: 'James Rodríguez',
    match_label: 'Colombia vs Uruguay, World Cup round of 16',
    year: 2014,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'gotze-final-2014',
    difficulty: 'easy',
    title: t(
      'Mario Götze — Germany vs Argentina, 2014 World Cup final',
      'მარიო გოტცე — გერმანია არგენტინასთან, 2014 მუნდიალის ფინალი'
    ),
    options: [
      opt('a', 'Mario Götze — Germany vs Argentina, 2014 final', 'მარიო გოტცე — გერმანია არგენტინასთან, 2014 ფინალი', true),
      opt('b', 'Andrés Iniesta — Spain vs Netherlands, 2010 final', 'ანდრეს ინიესტა — ესპანეთი ნიდერლანდებთან, 2010 ფინალი'),
      opt('c', 'Kylian Mbappé — France vs Croatia, 2018 final', 'კილიან ემბაპე — საფრანგეთი ხორვატიასთან, 2018 ფინალი'),
      opt('d', 'Fernando Torres — Spain vs Germany, Euro 2008 final', 'ფერნანდო ტორესი — ესპანეთი გერმანიასთან, ევრო 2008 ფინალი'),
    ],
    fun_fact: t(
      '113th minute at the Maracanã: Schürrle tore down the left, Götze chested the cross and volleyed in one motion — a World Cup won by a substitute.',
      '113-ე წუთი "მარაკანაზე": შიურლე მარცხენა ფლანგზე გაიჭრა, გოტცემ გადმოცემა მკერდით დაიმორჩილა და ერთი მოძრაობით ჩააწვინა — მუნდიალი შემცვლელმა მოიგო.'
    ),
    bonus: {
      question: t('Who crossed for Götze?', 'ვინ გადმოაწოდა გოტცეს?'),
      options: [
        opt('a', 'André Schürrle', 'ანდრე შიურლე', true),
        opt('b', 'Thomas Müller', 'თომას მიულერი'),
        opt('c', 'Mesut Özil', 'მესუთ ოზილი'),
        opt('d', 'Toni Kroos', 'ტონი კროსი'),
      ],
    },
    players: [
      { id: 'schurrle', team: 'attack', at: [10, 68] },
      { id: 'gotze', team: 'attack', at: [30, 85] },
      { id: 'muller', team: 'attack', at: [44, 84] },
      { id: 'd1', team: 'defense', at: [24, 86] },
      { id: 'd2', team: 'defense', at: [36, 92] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'carry', player: 'schurrle', to: [13, 88], via: [8, 78], duration: 1.7 },
      { kind: 'pass', player: 'schurrle', to: [37, 93], via: [24, 94], loft: 0.7, duration: 1.2 },
      { kind: 'run', player: 'gotze', to: [37, 93], withPrev: true, duration: 1.1 },
      { kind: 'shot', player: 'gotze', to: [36, 104], loft: 0.3, duration: 0.7 },
    ],
    scorer: 'Mario Götze',
    match_label: 'Germany vs Argentina, World Cup final',
    year: 2014,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'iniesta-final-2010',
    difficulty: 'easy',
    title: t(
      'Andrés Iniesta — Spain vs Netherlands, 2010 World Cup final',
      'ანდრეს ინიესტა — ესპანეთი ნიდერლანდებთან, 2010 მუნდიალის ფინალი'
    ),
    options: [
      opt('a', 'Andrés Iniesta — Spain vs Netherlands, 2010 final', 'ანდრეს ინიესტა — ესპანეთი ნიდერლანდებთან, 2010 ფინალი', true),
      opt('b', 'Mario Götze — Germany vs Argentina, 2014 final', 'მარიო გოტცე — გერმანია არგენტინასთან, 2014 ფინალი'),
      opt('c', 'David Villa — Spain vs Portugal, 2010', 'დავიდ ვილია — ესპანეთი პორტუგალიასთან, 2010'),
      opt('d', 'Xavi — Spain vs Germany, Euro 2008', 'ხავი — ესპანეთი გერმანიასთან, ევრო 2008'),
    ],
    fun_fact: t(
      "116th minute: Fàbregas slid it through, Iniesta let it bounce once and half-volleyed past Stekelenburg — Spain's first star, dedicated to Dani Jarque.",
      '116-ე წუთი: ფაბრეგასმა გაუტანა, ინიესტამ ბურთი ერთხელ დაახტუნა და შტეკელენბურგს ვოლეით გაუტანა — ესპანეთის პირველი ვარსკვლავი, დანი ხარკეს ხსოვნისადმი.'
    ),
    bonus: {
      question: t('Whose name was on the shirt Iniesta revealed?', 'ვისი სახელი ეწერა ინიესტას მაისურზე?'),
      options: [
        opt('a', 'Dani Jarque', 'დანი ხარკე', true),
        opt('b', 'Antonio Puerta', 'ანტონიო პუერტა'),
        opt('c', 'Luis Aragonés', 'ლუის არაგონესი'),
        opt('d', 'His daughter', 'მისი ქალიშვილი'),
      ],
    },
    players: [
      { id: 'fabregas', team: 'attack', at: [38, 76] },
      { id: 'iniesta', team: 'attack', at: [42, 80] },
      { id: 'torres', team: 'attack', at: [22, 84] },
      { id: 'd1', team: 'defense', at: [32, 86] },
      { id: 'd2', team: 'defense', at: [42, 90] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'pass', player: 'fabregas', to: [45, 87], duration: 1.5 },
      { kind: 'run', player: 'iniesta', to: [45, 87], withPrev: true, duration: 1.4 },
      { kind: 'shot', player: 'iniesta', to: [32, 104], loft: 0.4, duration: 1.7 },
    ],
    scorer: 'Andrés Iniesta',
    match_label: 'Spain vs Netherlands, World Cup final',
    year: 2010,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'son-burnley-2020',
    difficulty: 'medium',
    title: t(
      'Son Heung-min — Tottenham vs Burnley, 2020 (70-metre solo)',
      'სონ ჰიუნ-მინი — ტოტენჰემი ბერნლისთან, 2020 (70-მეტრიანი სოლო)'
    ),
    options: [
      opt('a', 'Son Heung-min — Tottenham vs Burnley, 2020', 'სონ ჰიუნ-მინი — ტოტენჰემი ბერნლისთან, 2020', true),
      opt('b', 'Gareth Bale — Tottenham vs Inter, 2010', 'გარეთ ბეილი — ტოტენჰემი ინტერთან, 2010'),
      opt('c', 'George Weah — AC Milan vs Verona, 1996', 'ჯორჯ ვეა — მილანი ვერონასთან, 1996'),
      opt('d', 'Mohamed Salah — Liverpool vs Everton, 2018', 'მოჰამედ სალაჰი — ლივერპული ევერტონთან, 2018'),
    ],
    fun_fact: t(
      'Picked it up in his own box and outran the entire Burnley team, 70 metres in 12 touches — the 2020 Puskás Award winner.',
      'ბურთი საკუთარ ჯარიმის მოედანში აიღო და მთელ ბერნლის გაექცა — 70 მეტრი 12 შეხებაში, 2020 წლის "პუშკაშის" ჯილდო.'
    ),
    bonus: {
      question: t('What award did this run win?', 'რომელი ჯილდო მოუტანა ამ სოლომ?'),
      options: [
        opt('a', 'FIFA Puskás Award', 'ФИФА "პუშკაშის" ჯილდო', true),
        opt('b', 'PFA Goal of the Month only', 'მხოლოდ თვის გოლი'),
        opt('c', "Ballon d'Or", '"ოქროს ბურთი"'),
        opt('d', 'None', 'არცერთი'),
      ],
    },
    players: [
      { id: 'son', team: 'attack', at: [30, 20] },
      { id: 'kane', team: 'attack', at: [40, 55] },
      { id: 'd1', team: 'defense', at: [34, 40] },
      { id: 'd2', team: 'defense', at: [28, 62] },
      { id: 'd3', team: 'defense', at: [38, 78] },
      { id: 'd4', team: 'defense', at: [30, 90] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'carry', player: 'son', to: [33, 48], via: [38, 32], duration: 2.0 },
      { kind: 'carry', player: 'son', to: [35, 74], via: [31, 60], duration: 1.8 },
      { kind: 'carry', player: 'son', to: [36, 94], via: [40, 84], duration: 1.5 },
      { kind: 'shot', player: 'son', to: [33, 104], duration: 0.6 },
    ],
    scorer: 'Son Heung-min',
    match_label: 'Tottenham vs Burnley, Premier League',
    year: 2020,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'ronaldinho-england-2002',
    difficulty: 'medium',
    title: t(
      'Ronaldinho — Brazil vs England, 2002 World Cup (the free-kick lob)',
      'რონალდინიო — ბრაზილია ინგლისთან, 2002 მუნდიალი (შტრაფით გადაგდება)'
    ),
    options: [
      opt('a', 'Ronaldinho — Brazil vs England, 2002', 'რონალდინიო — ბრაზილია ინგლისთან, 2002', true),
      opt('b', 'Roberto Carlos — Brazil vs France, 1997', 'რობერტო კარლოსი — ბრაზილია საფრანგეთთან, 1997'),
      opt('c', 'David Beckham — England vs Greece, 2001', 'დევიდ ბექჰემი — ინგლისი საბერძნეთთან, 2001'),
      opt('d', 'Ronaldinho — Barcelona vs Real Madrid, 2005', 'რონალდინიო — ბარსელონა რეალთან, 2005'),
    ],
    fun_fact: t(
      'From 40 yards, the free kick sailed over a stranded David Seaman into the top corner. Ronaldinho always insisted it was deliberate.',
      '40 იარდიდან შესრულებული შტრაფი კარიდან გამოსულ სიმენს ზემოდან გადაუფრინდა. რონალდინიო ბოლომდე ამტკიცებდა, რომ განზრახ დაარტყა.'
    ),
    bonus: {
      question: t('Which keeper was caught off his line?', 'რომელი მეკარე შერჩა კარს მოშორებული?'),
      options: [
        opt('a', 'David Seaman', 'დევიდ სიმენი', true),
        opt('b', 'David James', 'დევიდ ჯეიმსი'),
        opt('c', 'Nigel Martyn', 'ნაიჯელ მარტინი'),
        opt('d', 'Paul Robinson', 'პოლ რობინსონი'),
      ],
    },
    players: [
      { id: 'ronaldinho', team: 'attack', at: [42, 66] },
      { id: 'rivaldo', team: 'attack', at: [30, 80] },
      { id: 'wall1', team: 'defense', at: [38, 76] },
      { id: 'wall2', team: 'defense', at: [41, 76] },
      { id: 'gk', team: 'keeper', at: [32, 98] },
    ],
    steps: [
      { kind: 'carry', player: 'ronaldinho', to: [42, 68], duration: 1.2 },
      { kind: 'shot', player: 'ronaldinho', to: [38, 104], loft: 0.9, duration: 2.0 },
    ],
    scorer: 'Ronaldinho',
    match_label: 'Brazil vs England, World Cup quarter-final',
    year: 2002,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'ronaldo-compostela-1996',
    difficulty: 'hard',
    title: t(
      'Ronaldo — Barcelona vs Compostela, 1996 (dragged through fouls)',
      'რონალდო — ბარსელონა კომპოსტელასთან, 1996 (ფოლებში გატანილი)'
    ),
    options: [
      opt('a', 'Ronaldo — Barcelona vs Compostela, 1996', 'რონალდო — ბარსელონა კომპოსტელასთან, 1996', true),
      opt('b', 'Lionel Messi — Barcelona vs Getafe, 2007', 'ლიონელ მესი — ბარსელონა ხეტაფესთან, 2007'),
      opt('c', 'George Weah — AC Milan vs Verona, 1996', 'ჯორჯ ვეა — მილანი ვერონასთან, 1996'),
      opt('d', 'Romário — Barcelona vs Real Madrid, 1994', 'რომარიო — ბარსელონა რეალთან, 1994'),
    ],
    fun_fact: t(
      "R9 shrugged off three fouls and dragged two defenders from halfway to the six-yard box. Bobby Robson stood on the touchline holding his head.",
      'R9-მა სამი ფოლი აიტანა და ორი მცველი ცენტრიდან კარის ზონამდე მიათრია. ბობი რობსონი ხაზთან თავში ხელებწაჭიდებული იდგა.'
    ),
    bonus: {
      question: t("Who was Barcelona's manager holding his head in disbelief?", 'ბარსელონას რომელი მწვრთნელი იჭერდა თავს გაოცებისგან?'),
      options: [
        opt('a', 'Bobby Robson', 'ბობი რობსონი', true),
        opt('b', 'Johan Cruyff', 'იოჰან კროიფი'),
        opt('c', 'Louis van Gaal', 'ლუი ვან გალი'),
        opt('d', 'Pep Guardiola', 'პეპ გვარდიოლა'),
      ],
    },
    players: [
      { id: 'ronaldo', team: 'attack', at: [40, 45] },
      { id: 'giovanni', team: 'attack', at: [22, 70] },
      { id: 'd1', team: 'defense', at: [44, 52] },
      { id: 'd2', team: 'defense', at: [36, 64] },
      { id: 'd3', team: 'defense', at: [40, 80] },
      { id: 'd4', team: 'defense', at: [32, 92] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'carry', player: 'ronaldo', to: [42, 62], via: [47, 52], duration: 1.7 },
      { kind: 'carry', player: 'ronaldo', to: [37, 80], via: [33, 70], duration: 1.6 },
      { kind: 'carry', player: 'ronaldo', to: [33, 95], via: [38, 88], duration: 1.4 },
      { kind: 'shot', player: 'ronaldo', to: [36, 104], duration: 0.6 },
    ],
    scorer: 'Ronaldo Nazário',
    match_label: 'Barcelona vs Compostela, La Liga',
    year: 1996,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'cristiano-porto-2009',
    difficulty: 'medium',
    title: t(
      'Cristiano Ronaldo — Porto vs Man United, 2009 (40-yard thunderbolt)',
      'კრიშტიანუ რონალდუ — პორტუ მან. იუნაიტედთან, 2009 (40-იარდიანი ჭექა-ქუხილი)'
    ),
    options: [
      opt('a', 'Cristiano Ronaldo — Porto vs Man United, 2009', 'კრიშტიანუ რონალდუ — პორტუ მან. იუნაიტედთან, 2009', true),
      opt('b', 'Steven Gerrard — Liverpool vs Olympiacos, 2004', 'სტივენ ჯერარდი — ლივერპული ოლიმპიაკოსთან, 2004'),
      opt('c', 'Cristiano Ronaldo — Real Madrid vs Juventus, 2018', 'კრიშტიანუ რონალდუ — რეალი იუვენტუსთან, 2018'),
      opt('d', 'Frank Lampard — Chelsea vs Barcelona, 2009', 'ფრენკ ლემპარდი — ჩელსი ბარსელონასთან, 2009'),
    ],
    fun_fact: t(
      'A 40-yard knuckleball at the Estádio do Dragão that Ronaldo still calls his favourite goal — it won the inaugural FIFA Puskás Award.',
      '40-იარდიანი "კნაკლბოლი" "დრაგაოზე", რომელსაც რონალდუ დღემდე საყვარელ გოლს უწოდებს — პირველი "პუშკაშის" ჯილდოს მფლობელი.'
    ),
    bonus: {
      question: t('This goal won the first-ever…', 'ამ გოლმა მოიგო პირველი…'),
      options: [
        opt('a', 'FIFA Puskás Award', 'ФИФА "პუშკაშის" ჯილდო', true),
        opt('b', 'UEFA Goal of the Season', 'UEFA სეზონის გოლი'),
        opt('c', 'BBC Goal of the Month', 'BBC თვის გოლი'),
        opt('d', "Ballon d'Or", '"ოქროს ბურთი"'),
      ],
    },
    players: [
      { id: 'anderson', team: 'attack', at: [28, 58] },
      { id: 'cristiano', team: 'attack', at: [36, 62] },
      { id: 'rooney', team: 'attack', at: [44, 84] },
      { id: 'd1', team: 'defense', at: [30, 78] },
      { id: 'd2', team: 'defense', at: [40, 82] },
      { id: 'gk', team: 'keeper', at: [34, 101] },
    ],
    steps: [
      { kind: 'pass', player: 'anderson', to: [37, 63], duration: 1.2 },
      { kind: 'shot', player: 'cristiano', to: [37, 105], via: [41, 85], loft: 0.4, duration: 2.0 },
    ],
    scorer: 'Cristiano Ronaldo',
    match_label: 'Porto vs Manchester United, Champions League quarter-final',
    year: 2009,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'cristiano-juventus-2018',
    difficulty: 'easy',
    title: t(
      'Cristiano Ronaldo — Juventus vs Real Madrid, 2018 (the bicycle kick)',
      'კრიშტიანუ რონალდუ — იუვენტუსი რეალთან, 2018 ("მაკრატელა")'
    ),
    options: [
      opt('a', 'Cristiano Ronaldo — Juventus vs Real Madrid, 2018', 'კრიშტიანუ რონალდუ — იუვენტუსი რეალთან, 2018', true),
      opt('b', 'Gareth Bale — Real Madrid vs Liverpool, 2018 final', 'გარეთ ბეილი — რეალი ლივერპულთან, 2018 ფინალი'),
      opt('c', 'Wayne Rooney — Man United vs Man City, 2011', 'უეინ რუნი — მან. იუნაიტედი მან. სიტისთან, 2011'),
      opt('d', 'Zlatan Ibrahimović — Sweden vs England, 2012', 'ზლატან იბრაჰიმოვიჩი — შვედეთი ინგლისთან, 2012'),
    ],
    fun_fact: t(
      "Carvajal's cross, and Ronaldo hung 2.38 metres off the turf in Turin — even the Juventus fans stood to applaud him.",
      'კარვახალის გადმოცემა და რონალდუ ტურინში მიწიდან 2.38 მეტრზე გაიჭიმა — ფეხზე იუვენტუსის გულშემატკივრებიც კი ადგნენ ტაშით.'
    ),
    bonus: {
      question: t('What did the Juventus fans do after the goal?', 'რა გააკეთეს იუვენტუსის გულშემატკივრებმა გოლის შემდეგ?'),
      options: [
        opt('a', 'Gave him a standing ovation', 'ფეხზე ადგომით დაუკრეს ტაში', true),
        opt('b', 'Threw objects on the pitch', 'საგნები ისროლეს მოედანზე'),
        opt('c', 'Left the stadium', 'დატოვეს სტადიონი'),
        opt('d', 'Booed him', 'ჩაუსტვინეს'),
      ],
    },
    players: [
      { id: 'carvajal', team: 'attack', at: [52, 74] },
      { id: 'cristiano', team: 'attack', at: [36, 86] },
      { id: 'lucas', team: 'attack', at: [46, 90] },
      { id: 'd1', team: 'defense', at: [30, 88] },
      { id: 'd2', team: 'defense', at: [42, 92] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'carry', player: 'carvajal', to: [53, 82], duration: 1.2 },
      { kind: 'pass', player: 'carvajal', to: [38, 90], via: [46, 92], loft: 0.8, duration: 1.2 },
      { kind: 'shot', player: 'cristiano', to: [31, 104], loft: 0.7, duration: 0.9 },
    ],
    scorer: 'Cristiano Ronaldo',
    match_label: 'Juventus vs Real Madrid, Champions League quarter-final',
    year: 2018,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'bale-copa-final-2014',
    difficulty: 'medium',
    title: t(
      'Gareth Bale — Real Madrid vs Barcelona, 2014 Copa del Rey final',
      'გარეთ ბეილი — რეალი ბარსელონასთან, 2014 კოპას ფინალი'
    ),
    options: [
      opt('a', 'Gareth Bale — Real Madrid vs Barcelona, 2014', 'გარეთ ბეილი — რეალი ბარსელონასთან, 2014', true),
      opt('b', 'Cristiano Ronaldo — Real Madrid vs Barcelona, 2011', 'კრიშტიანუ რონალდუ — რეალი ბარსელონასთან, 2011'),
      opt('c', 'Arjen Robben — Bayern vs Dortmund, 2013 final', 'არიენ რობენი — ბაერნი დორტმუნდთან, 2013 ფინალი'),
      opt('d', 'Kylian Mbappé — PSG vs Monaco, 2017', 'კილიან ემბაპე — პსჟ მონაკოსთან, 2017'),
    ],
    fun_fact: t(
      'Knocked it past Bartra and sprinted OFF the pitch and back on to beat him — 60 metres in under 7 seconds to win a Clásico cup final.',
      'ბურთი ბარტრას გვერდით გააგდო, მოედნის გარეთ გაურბინა და ისევ შემობრუნდა — 60 მეტრი 7 წამში "კლასიკოს" ფინალის მოსაგებად.'
    ),
    bonus: {
      question: t('Which defender did Bale outrun off the pitch?', 'რომელ მცველს გაასწრო ბეილმა მოედნის გარეთ?'),
      options: [
        opt('a', 'Marc Bartra', 'მარკ ბარტრა', true),
        opt('b', 'Gerard Piqué', 'ჟერარ პიკე'),
        opt('c', 'Dani Alves', 'დანი ალვესი'),
        opt('d', 'Javier Mascherano', 'ხავიერ მასჩერანო'),
      ],
    },
    players: [
      { id: 'coentrao', team: 'attack', at: [14, 48] },
      { id: 'bale', team: 'attack', at: [10, 56] },
      { id: 'benzema', team: 'attack', at: [40, 82] },
      { id: 'bartra', team: 'defense', at: [12, 62] },
      { id: 'd2', team: 'defense', at: [28, 88] },
      { id: 'gk', team: 'keeper', at: [34, 101] },
    ],
    steps: [
      { kind: 'pass', player: 'coentrao', to: [11, 57], duration: 0.7 },
      { kind: 'carry', player: 'bale', to: [8, 80], via: [2, 68], duration: 1.9 },
      { kind: 'carry', player: 'bale', to: [22, 94], via: [12, 90], duration: 1.4 },
      { kind: 'shot', player: 'bale', to: [33, 103], duration: 0.7 },
    ],
    scorer: 'Gareth Bale',
    match_label: 'Real Madrid vs Barcelona, Copa del Rey final',
    year: 2014,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'bale-ucl-final-2018',
    difficulty: 'medium',
    title: t(
      'Gareth Bale — Real Madrid vs Liverpool, 2018 Champions League final',
      'გარეთ ბეილი — რეალი ლივერპულთან, 2018 ჩემპიონთა ლიგის ფინალი'
    ),
    options: [
      opt('a', 'Gareth Bale — Real Madrid vs Liverpool, 2018 final', 'გარეთ ბეილი — რეალი ლივერპულთან, 2018 ფინალი', true),
      opt('b', 'Cristiano Ronaldo — Juventus vs Real Madrid, 2018', 'კრიშტიანუ რონალდუ — იუვენტუსი რეალთან, 2018'),
      opt('c', "Marco van Basten — Netherlands vs USSR, Euro '88", 'მარკო ვან ბასტენი — ევრო 88'),
      opt('d', 'Mario Mandžukić — Juventus vs Real Madrid, 2017 final', 'მარიო მანჯუკიჩი — იუვენტუსი რეალთან, 2017 ფინალი'),
    ],
    fun_fact: t(
      'On as a sub for two minutes, Bale met Marcelo\'s cross with an overhead kick that even Zidane, scorer of THAT 2002 volley, applauded in disbelief.',
      'შემცვლელად შემოსვლიდან ორ წუთში ბეილმა მარსელოს გადმოცემას "მაკრატელათი" უპასუხა — ისეთი, რომ 2002-ის ვოლეის ავტორმა ზიდანმაც კი ვერ დამალა აღტაცება.'
    ),
    bonus: {
      question: t('How long had Bale been on the pitch?', 'რამდენი ხანი იყო ბეილი მოედანზე ამ გოლისას?'),
      options: [
        opt('a', 'About 2 minutes', 'დაახლოებით 2 წუთი', true),
        opt('b', 'The whole match', 'მთელი მატჩი'),
        opt('c', 'About 30 minutes', 'დაახლოებით 30 წუთი'),
        opt('d', 'Since half-time', 'მეორე ტაიმიდან'),
      ],
    },
    players: [
      { id: 'marcelo', team: 'attack', at: [12, 74] },
      { id: 'bale', team: 'attack', at: [34, 84] },
      { id: 'benzema', team: 'attack', at: [44, 88] },
      { id: 'd1', team: 'defense', at: [26, 88] },
      { id: 'd2', team: 'defense', at: [40, 92] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'carry', player: 'marcelo', to: [14, 80], duration: 1.0 },
      { kind: 'pass', player: 'marcelo', to: [36, 88], via: [24, 90], loft: 0.7, duration: 1.2 },
      { kind: 'shot', player: 'bale', to: [37, 104], loft: 0.8, duration: 0.9 },
    ],
    scorer: 'Gareth Bale',
    match_label: 'Real Madrid vs Liverpool, Champions League final',
    year: 2018,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'kvaratskhelia-atalanta-2023',
    difficulty: 'medium',
    title: t(
      'Khvicha Kvaratskhelia — Napoli vs Atalanta, 2023 (the slalom)',
      'ხვიჩა კვარაცხელია — ნაპოლი ატალანტასთან, 2023 (სლალომი)'
    ),
    options: [
      opt('a', 'Khvicha Kvaratskhelia — Napoli vs Atalanta, 2023', 'ხვიჩა კვარაცხელია — ნაპოლი ატალანტასთან, 2023', true),
      opt('b', 'Lionel Messi — Barcelona vs Getafe, 2007', 'ლიონელ მესი — ბარსელონა ხეტაფესთან, 2007'),
      opt('c', 'Eden Hazard — Chelsea vs Arsenal, 2017', 'ედენ აზარი — ჩელსი არსენალთან, 2017'),
      opt('d', 'Jay-Jay Okocha — Bolton vs West Ham, 2003', 'ჯეი-ჯეი ოკოჩა — ბოლტონი ვესტ ჰემთან, 2003'),
    ],
    fun_fact: t(
      "Kvaradona at the Maradona: four Atalanta defenders beaten in the box before the finish, in Napoli's first scudetto season in 33 years.",
      '"კვარადონა" "მარადონას" სტადიონზე: ოთხი მცველი მოტყუებული და გოლი — ნაპოლის 33 წლის ნანატრი "სკუდეტოს" სეზონში.'
    ),
    bonus: {
      question: t('What did Napoli win that season?', 'რა მოიგო ნაპოლიმ იმ სეზონში?'),
      options: [
        opt('a', 'The Serie A title (scudetto)', 'სერია A-ს ჩემპიონობა ("სკუდეტო")', true),
        opt('b', 'The Champions League', 'ჩემპიონთა ლიგა'),
        opt('c', 'The Coppa Italia', 'იტალიის თასი'),
        opt('d', 'Nothing', 'ვერაფერი'),
      ],
    },
    players: [
      { id: 'kvara', team: 'attack', at: [10, 70] },
      { id: 'osimhen', team: 'attack', at: [38, 90] },
      { id: 'd1', team: 'defense', at: [16, 78] },
      { id: 'd2', team: 'defense', at: [22, 86] },
      { id: 'd3', team: 'defense', at: [30, 92] },
      { id: 'd4', team: 'defense', at: [38, 96] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'carry', player: 'kvara', to: [18, 84], via: [12, 78], duration: 1.6 },
      { kind: 'carry', player: 'kvara', to: [27, 92], via: [21, 90], duration: 1.4 },
      { kind: 'shot', player: 'kvara', to: [37, 104], duration: 0.7 },
    ],
    scorer: 'Khvicha Kvaratskhelia',
    match_label: 'Napoli vs Atalanta, Serie A',
    year: 2023,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'kvaratskhelia-portugal-2024',
    difficulty: 'easy',
    title: t(
      'Khvicha Kvaratskhelia — Georgia vs Portugal, Euro 2024',
      'ხვიჩა კვარაცხელია — საქართველო პორტუგალიასთან, ევრო 2024'
    ),
    options: [
      opt('a', 'Khvicha Kvaratskhelia — Georgia vs Portugal, Euro 2024', 'ხვიჩა კვარაცხელია — საქართველო პორტუგალიასთან, ევრო 2024', true),
      opt('b', 'Georges Mikautadze — Georgia vs Czechia, Euro 2024', 'ჟორჟ მიქაუტაძე — საქართველო ჩეხეთთან, ევრო 2024'),
      opt('c', 'Khvicha Kvaratskhelia — Napoli vs Atalanta, 2023', 'ხვიჩა კვარაცხელია — ნაპოლი ატალანტასთან, 2023'),
      opt('d', 'Temur Ketsbaia — Georgia vs Wales, 1995', 'თემურ ქეცბაია — საქართველო უელსთან, 1995'),
    ],
    fun_fact: t(
      "Second minute against Ronaldo's Portugal: a counter from Georgia's own half and Kvaratskhelia buried it — the night Georgia reached the Euro knockouts at their first-ever major tournament.",
      'მეორე წუთი რონალდუს პორტუგალიასთან: კონტრშეტევა საკუთარი ნახევრიდან და კვარაცხელიას გოლი — ღამე, როცა საქართველო პირველივე დიდ ტურნირზე პლეი-ოფში გავიდა.'
    ),
    bonus: {
      question: t('What was the final score that night in Gelsenkirchen?', 'რა ანგარიშით დასრულდა ის მატჩი გელზენკირხენში?'),
      options: [
        opt('a', 'Georgia 2–0 Portugal', 'საქართველო 2–0 პორტუგალია', true),
        opt('b', 'Georgia 1–0 Portugal', 'საქართველო 1–0 პორტუგალია'),
        opt('c', 'Georgia 2–1 Portugal', 'საქართველო 2–1 პორტუგალია'),
        opt('d', 'Georgia 3–1 Portugal', 'საქართველო 3–1 პორტუგალია'),
      ],
    },
    players: [
      { id: 'kochorashvili', team: 'attack', at: [36, 40] },
      { id: 'kvara', team: 'attack', at: [22, 55] },
      { id: 'mikautadze', team: 'attack', at: [42, 78] },
      { id: 'd1', team: 'defense', at: [30, 70] },
      { id: 'd2', team: 'defense', at: [40, 86] },
      { id: 'gk', team: 'keeper', at: [34, 101] },
    ],
    steps: [
      { kind: 'carry', player: 'kochorashvili', to: [34, 48], duration: 1.0 },
      { kind: 'pass', player: 'kochorashvili', to: [23, 58], duration: 0.9 },
      { kind: 'carry', player: 'kvara', to: [27, 86], via: [20, 72], duration: 2.0 },
      { kind: 'shot', player: 'kvara', to: [36, 104], duration: 0.7 },
    ],
    scorer: 'Khvicha Kvaratskhelia',
    match_label: 'Georgia vs Portugal, Euro group stage',
    year: 2024,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'wilshere-norwich-2013',
    difficulty: 'medium',
    title: t(
      'Jack Wilshere — Arsenal vs Norwich, 2013 (the one-touch move)',
      'ჯეკ უილშერი — არსენალი ნორვიჩთან, 2013 (ერთი შეხების კომბინაცია)'
    ),
    options: [
      opt('a', 'Jack Wilshere — Arsenal vs Norwich, 2013', 'ჯეკ უილშერი — არსენალი ნორვიჩთან, 2013', true),
      opt('b', 'Esteban Cambiasso — Argentina vs Serbia, 2006', 'ესტებან კამბიასო — არგენტინა სერბეთთან, 2006'),
      opt('c', 'Carlos Alberto — Brazil vs Italy, 1970', 'კარლოს ალბერტო — ბრაზილია იტალიასთან, 1970'),
      opt('d', 'Dennis Bergkamp — Arsenal vs Newcastle, 2002', 'დენის ბერგკამპი — არსენალი ნიუკასლთან, 2002'),
    ],
    fun_fact: t(
      'A blur of one-touch flicks with Giroud and Cazorla at the edge of the box — Wilshere finished a move he started, without the ball ever stopping.',
      'ჟირუსთან და კასორლასთან ერთშეხებიანი კომბინაციების ქარბორბალა — უილშერმა თავადვე დაასრულა შეტევა ისე, რომ ბურთი არც გაჩერებულა.'
    ),
    bonus: {
      question: t('Whose backheel flick set up the finish?', 'ვისმა უკუქუსლმა შექმნა საგოლე მომენტი?'),
      options: [
        opt('a', 'Olivier Giroud', 'ოლივიე ჟირუ', true),
        opt('b', 'Santi Cazorla', 'სანტი კასორლა'),
        opt('c', 'Mesut Özil', 'მესუთ ოზილი'),
        opt('d', 'Aaron Ramsey', 'აარონ რემზი'),
      ],
    },
    players: [
      { id: 'wilshere', team: 'attack', at: [38, 68] },
      { id: 'cazorla', team: 'attack', at: [30, 76] },
      { id: 'giroud', team: 'attack', at: [36, 84] },
      { id: 'd1', team: 'defense', at: [32, 80] },
      { id: 'd2', team: 'defense', at: [40, 88] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'pass', player: 'wilshere', to: [31, 77], duration: 0.9 },
      { kind: 'pass', player: 'cazorla', to: [36, 84], duration: 0.9 },
      { kind: 'pass', player: 'giroud', to: [38, 88], duration: 0.9 },
      { kind: 'run', player: 'wilshere', to: [38, 88], withPrev: true, duration: 1.4 },
      { kind: 'shot', player: 'wilshere', to: [32, 104], loft: 0.4, duration: 0.8 },
    ],
    scorer: 'Jack Wilshere',
    match_label: 'Arsenal vs Norwich, Premier League',
    year: 2013,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'bergkamp-newcastle-2002',
    difficulty: 'medium',
    title: t(
      'Dennis Bergkamp — Arsenal vs Newcastle, 2002 (the pirouette)',
      'დენის ბერგკამპი — არსენალი ნიუკასლთან, 2002 (პირუეტი)'
    ),
    options: [
      opt('a', 'Dennis Bergkamp — Arsenal vs Newcastle, 2002', 'დენის ბერგკამპი — არსენალი ნიუკასლთან, 2002', true),
      opt('b', 'Dennis Bergkamp — Netherlands vs Argentina, 1998', 'დენის ბერგკამპი — ნიდერლანდები არგენტინასთან, 1998'),
      opt('c', 'Thierry Henry — Arsenal vs Man United, 2000', 'ტიერი ანრი — არსენალი მან. იუნაიტედთან, 2000'),
      opt('d', 'Ronaldinho — Barcelona vs Chelsea, 2005', 'რონალდინიო — ბარსელონა ჩელსისთან, 2005'),
    ],
    fun_fact: t(
      "Flicked Pirès's pass one way round Dabizas and spun the other way to meet it — voted the Premier League's greatest ever goal. Did he mean it? He always smiled.",
      'პირესის პასი ერთი მხრიდან ჩამოაგდო, თავად კი მეორე მხრიდან შემოუარა დაბიზასს — პრემიერლიგის ისტორიის საუკეთესო გოლად აღიარებული პირუეტი.'
    ),
    bonus: {
      question: t('Which defender was left behind by the spin?', 'რომელი მცველი დარჩა პირუეტის შემდეგ?'),
      options: [
        opt('a', 'Nikos Dabizas', 'ნიკოს დაბიზასი', true),
        opt('b', 'Jonathan Woodgate', 'ჯონათან ვუდგეიტი'),
        opt('c', 'Sol Campbell', 'სოლ კემპბელი'),
        opt('d', 'Titus Bramble', 'ტიტუს ბრემბლი'),
      ],
    },
    players: [
      { id: 'pires', team: 'attack', at: [30, 62] },
      { id: 'bergkamp', team: 'attack', at: [38, 76] },
      { id: 'dabizas', team: 'defense', at: [39, 80] },
      { id: 'd2', team: 'defense', at: [28, 88] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'pass', player: 'pires', to: [38, 77], duration: 0.9 },
      { kind: 'carry', player: 'bergkamp', to: [36, 88], via: [43, 82], duration: 1.4 },
      { kind: 'shot', player: 'bergkamp', to: [33, 104], duration: 0.7 },
    ],
    scorer: 'Dennis Bergkamp',
    match_label: 'Newcastle vs Arsenal, Premier League',
    year: 2002,
    goal_ordinal: 1,
    schema_version: 1,
  },
];
