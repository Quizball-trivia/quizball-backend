import type { ChoreographyContent } from '../../src/modules/guess-the-goal/guess-the-goal.schemas.js';

/**
 * Hand-authored seed choreographies, part 1: the all-time classics. Coordinates
 * on a 68×105 pitch, attack toward y=105. Options are authored correct-first;
 * the server shuffles per session, so storage order never leaks.
 */

const t = (en: string, ka: string) => ({ en, ka });
const opt = (id: string, en: string, ka: string, correct = false) => ({
  id,
  text: t(en, ka),
  is_correct: correct,
});

export const CLASSIC_GOALS: ChoreographyContent[] = [
  {
    slug: 'carlos-alberto-1970',
    difficulty: 'easy',
    title: t(
      'Carlos Alberto — Brazil vs Italy, 1970 World Cup final',
      'კარლოს ალბერტო — ბრაზილია იტალიასთან, 1970 წლის მუნდიალის ფინალი'
    ),
    options: [
      opt('a', 'Carlos Alberto — Brazil vs Italy, 1970 World Cup final', 'კარლოს ალბერტო — ბრაზილია იტალიასთან, 1970 მუნდიალის ფინალი', true),
      opt('b', 'Esteban Cambiasso — Argentina vs Serbia & Montenegro, 2006 World Cup', 'ესტებან კამბიასო — არგენტინა სერბეთი და მონტენეგროსთან, 2006 მუნდიალი'),
      opt('c', 'Jack Wilshere — Arsenal vs Norwich, 2013', 'ჯეკ უილშერი — არსენალი ნორვიჩთან, 2013'),
      opt('d', 'Dennis Bergkamp — Arsenal vs Newcastle, 2002', 'დენის ბერგკამპი — არსენალი ნიუკასლთან, 2002'),
    ],
    fun_fact: t(
      "Voted the greatest team goal in World Cup history — Pelé rolled the ball into Carlos Alberto's path without even looking up.",
      'მუნდიალის ისტორიის საუკეთესო გუნდურ გოლად აღიარებული — პელემ ბურთი აუხედავად გააგორა კარლოს ალბერტოს მიმართულებით.'
    ),
    bonus: {
      question: t("Who rolled the assist into Carlos Alberto's path?", 'ვინ გაუგორა საგოლე პასი კარლოს ალბერტოს?'),
      options: [
        opt('a', 'Pelé', 'პელე', true),
        opt('b', 'Jairzinho', 'ჟაირზინიო'),
        opt('c', 'Rivelino', 'რიველინო'),
        opt('d', 'Tostão', 'ტოსტაო'),
      ],
    },
    players: [
      { id: 'clodoaldo', team: 'attack', at: [28, 26] },
      { id: 'rivelino', team: 'attack', at: [8, 44] },
      { id: 'jairzinho', team: 'attack', at: [14, 64] },
      { id: 'pele', team: 'attack', at: [34, 78] },
      { id: 'tostao', team: 'attack', at: [42, 88] },
      { id: 'carlos_alberto', team: 'attack', at: [58, 38] },
      { id: 'd1', team: 'defense', at: [24, 34] },
      { id: 'd2', team: 'defense', at: [31, 38] },
      { id: 'd3', team: 'defense', at: [20, 70] },
      { id: 'd4', team: 'defense', at: [30, 84] },
      { id: 'd5', team: 'defense', at: [44, 92] },
      { id: 'gk', team: 'keeper', at: [34, 103] },
    ],
    steps: [
      { kind: 'carry', player: 'clodoaldo', to: [30, 42], via: [21, 35], duration: 2.2 },
      { kind: 'pass', player: 'clodoaldo', to: [9, 46], duration: 1.0 },
      { kind: 'pass', player: 'rivelino', to: [14, 64], loft: 0.4, duration: 1.1 },
      { kind: 'carry', player: 'jairzinho', to: [25, 74], via: [18, 70], duration: 1.6 },
      { kind: 'pass', player: 'jairzinho', to: [35, 80], duration: 0.9 },
      { kind: 'run', player: 'carlos_alberto', to: [52, 86], withPrev: true, duration: 2.0 },
      { kind: 'pass', player: 'pele', to: [52, 86], duration: 1.0 },
      { kind: 'shot', player: 'carlos_alberto', to: [31, 105], loft: 0.15, duration: 0.7 },
    ],
    scorer: 'Carlos Alberto',
    match_label: 'Brazil vs Italy, World Cup final',
    year: 1970,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'maradona-england-1986',
    difficulty: 'easy',
    title: t(
      'Diego Maradona — Argentina vs England, 1986 World Cup',
      'დიეგო მარადონა — არგენტინა ინგლისთან, 1986 მუნდიალი'
    ),
    options: [
      opt('a', 'Diego Maradona — Argentina vs England, 1986 World Cup', 'დიეგო მარადონა — არგენტინა ინგლისთან, 1986 მუნდიალი', true),
      opt('b', 'Lionel Messi — Barcelona vs Getafe, 2007', 'ლიონელ მესი — ბარსელონა ხეტაფესთან, 2007'),
      opt('c', 'George Weah — AC Milan vs Verona, 1996', 'ჯორჯ ვეა — მილანი ვერონასთან, 1996'),
      opt('d', 'Ryan Giggs — Man United vs Arsenal, 1999', 'რაიან გიგზი — მანჩესტერ იუნაიტედი არსენალთან, 1999'),
    ],
    fun_fact: t(
      "The 'Goal of the Century' — 10.6 seconds, ~60 metres, five England players and Shilton beaten, four minutes after the Hand of God.",
      '"საუკუნის გოლი" — 10.6 წამი, ~60 მეტრი, ხუთი ინგლისელი და შილტონი აცდენილი, "ღვთის ხელიდან" ოთხ წუთში.'
    ),
    bonus: {
      question: t('Minutes before this goal, the same match saw…', 'ამ გოლამდე რამდენიმე წუთით ადრე ამავე მატჩში…'),
      options: [
        opt('a', "The 'Hand of God' goal", '"ღვთის ხელის" გოლი', true),
        opt('b', 'A missed England penalty', 'ინგლისის აცდენილი პენალტი'),
        opt('c', 'A red card for Argentina', 'წითელი ბარათი არგენტინას'),
        opt('d', 'An own goal by Shilton', 'შილტონის ავტოგოლი'),
      ],
    },
    players: [
      { id: 'maradona', team: 'attack', at: [44, 38] },
      { id: 'valdano', team: 'attack', at: [22, 80] },
      { id: 'd1', team: 'defense', at: [48, 44] },
      { id: 'd2', team: 'defense', at: [43, 50] },
      { id: 'd3', team: 'defense', at: [48, 66] },
      { id: 'd4', team: 'defense', at: [38, 86] },
      { id: 'd5', team: 'defense', at: [31, 94] },
      { id: 'gk', team: 'keeper', at: [34, 101] },
    ],
    steps: [
      { kind: 'carry', player: 'maradona', to: [46, 56], via: [51, 46], duration: 1.7 },
      { kind: 'carry', player: 'maradona', to: [44, 78], via: [53, 68], duration: 1.7 },
      { kind: 'carry', player: 'maradona', to: [35, 92], via: [40, 86], duration: 1.5 },
      { kind: 'carry', player: 'maradona', to: [30, 99], via: [29, 95], duration: 1.2 },
      { kind: 'shot', player: 'maradona', to: [33, 105], duration: 0.6 },
    ],
    scorer: 'Diego Maradona',
    match_label: 'Argentina vs England, World Cup quarter-final',
    year: 1986,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'messi-getafe-2007',
    difficulty: 'easy',
    title: t(
      'Lionel Messi — Barcelona vs Getafe, 2007 Copa del Rey',
      'ლიონელ მესი — ბარსელონა ხეტაფესთან, 2007 კოპა დელ რეი'
    ),
    options: [
      opt('a', 'Lionel Messi — Barcelona vs Getafe, 2007', 'ლიონელ მესი — ბარსელონა ხეტაფესთან, 2007', true),
      opt('b', 'Diego Maradona — Argentina vs England, 1986 World Cup', 'დიეგო მარადონა — არგენტინა ინგლისთან, 1986 მუნდიალი'),
      opt('c', 'Saeed Al-Owairan — Saudi Arabia vs Belgium, 1994', 'საიდ ალ-ოვაირანი — საუდის არაბეთი ბელგიასთან, 1994'),
      opt('d', 'Lionel Messi — Copa del Rey final vs Athletic, 2015', 'ლიონელ მესი — კოპას ფინალი ატლეტიკთან, 2015'),
    ],
    fun_fact: t(
      "An eerie mirror of Maradona '86, 21 years on — same start near halfway, same slalom, but Messi went round the keeper to the right.",
      'მარადონას 86 წლის გოლის ზუსტი ანარეკლი 21 წლის შემდეგ — იგივე დასაწყისი, იგივე სლალომი, ოღონდ მესიმ მეკარეს მარჯვნიდან შეუარა.'
    ),
    bonus: {
      question: t('Which competition was this Messi goal scored in?', 'რომელ ტურნირზე გაიტანა მესიმ ეს გოლი?'),
      options: [
        opt('a', 'Copa del Rey', 'კოპა დელ რეი', true),
        opt('b', 'La Liga', 'ლა ლიგა'),
        opt('c', 'Champions League', 'ჩემპიონთა ლიგა'),
        opt('d', 'Supercopa', 'სუპერთასი'),
      ],
    },
    players: [
      { id: 'messi', team: 'attack', at: [48, 40] },
      { id: 'eto', team: 'attack', at: [24, 82] },
      { id: 'd1', team: 'defense', at: [52, 46] },
      { id: 'd2', team: 'defense', at: [46, 52] },
      { id: 'd3', team: 'defense', at: [54, 72] },
      { id: 'd4', team: 'defense', at: [44, 90] },
      { id: 'd5', team: 'defense', at: [36, 96] },
      { id: 'gk', team: 'keeper', at: [34, 101] },
    ],
    steps: [
      { kind: 'carry', player: 'messi', to: [51, 58], via: [56, 48], duration: 1.6 },
      { kind: 'carry', player: 'messi', to: [52, 80], via: [57, 70], duration: 1.6 },
      { kind: 'carry', player: 'messi', to: [42, 94], via: [47, 88], duration: 1.4 },
      { kind: 'carry', player: 'messi', to: [39, 100], via: [42, 98], duration: 1.1 },
      { kind: 'shot', player: 'messi', to: [34, 105], loft: 0.2, duration: 0.6 },
    ],
    scorer: 'Lionel Messi',
    match_label: 'Barcelona vs Getafe, Copa del Rey semi-final',
    year: 2007,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'bergkamp-argentina-1998',
    difficulty: 'medium',
    title: t(
      'Dennis Bergkamp — Netherlands vs Argentina, 1998 World Cup',
      'დენის ბერგკამპი — ნიდერლანდები არგენტინასთან, 1998 მუნდიალი'
    ),
    options: [
      opt('a', 'Dennis Bergkamp — Netherlands vs Argentina, 1998 World Cup', 'დენის ბერგკამპი — ნიდერლანდები არგენტინასთან, 1998 მუნდიალი', true),
      opt('b', 'Dennis Bergkamp — Arsenal vs Newcastle, 2002', 'დენის ბერგკამპი — არსენალი ნიუკასლთან, 2002'),
      opt('c', "Marco van Basten — Netherlands vs USSR, Euro '88", 'მარკო ვან ბასტენი — ნიდერლანდები სსრკ-სთან, ევრო 88'),
      opt('d', 'David Trezeguet — France vs Italy, Euro 2000 final', 'დავიდ ტრეზეგე — საფრანგეთი იტალიასთან, ევრო 2000 ფინალი'),
    ],
    fun_fact: t(
      '89th-minute winner in the quarter-final: a 60-yard De Boer diagonal killed with one touch, Ayala beaten with the second, finished with the third.',
      '89-ე წუთის გადამწყვეტი გოლი მეოთხედფინალში: დე ბურის 60-იარდიანი დიაგონალი ერთი შეხებით დამუშავდა, მეორეთი აიალა აცდა, მესამეთი კი ბადეში აღმოჩნდა.'
    ),
    bonus: {
      question: t('Who hit the 60-yard pass Bergkamp plucked out of the air?', 'ვინ გააწოდა 60-იარდიანი პასი, რომელიც ბერგკამპმა ჰაერში დაიმორჩილა?'),
      options: [
        opt('a', 'Frank de Boer', 'ფრანკ დე ბური', true),
        opt('b', 'Edgar Davids', 'ედგარ დავიდსი'),
        opt('c', 'Ronald de Boer', 'რონალდ დე ბური'),
        opt('d', 'Clarence Seedorf', 'კლარენს სედორფი'),
      ],
    },
    players: [
      { id: 'f_de_boer', team: 'attack', at: [18, 26] },
      { id: 'bergkamp', team: 'attack', at: [54, 72] },
      { id: 'kluivert', team: 'attack', at: [30, 82] },
      { id: 'd1', team: 'defense', at: [26, 60] },
      { id: 'd2', team: 'defense', at: [40, 74] },
      { id: 'ayala', team: 'defense', at: [52, 90] },
      { id: 'd4', team: 'defense', at: [30, 92] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'carry', player: 'f_de_boer', to: [20, 33], duration: 1.2 },
      { kind: 'pass', player: 'f_de_boer', to: [55, 87], via: [34, 62], loft: 1, duration: 1.9 },
      { kind: 'run', player: 'bergkamp', to: [55, 87], withPrev: true, duration: 1.7 },
      { kind: 'carry', player: 'bergkamp', to: [50, 94], via: [55, 91], duration: 1.3 },
      { kind: 'shot', player: 'bergkamp', to: [32, 104], loft: 0.35, duration: 0.7 },
    ],
    scorer: 'Dennis Bergkamp',
    match_label: 'Netherlands vs Argentina, World Cup quarter-final',
    year: 1998,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'cambiasso-serbia-2006',
    difficulty: 'medium',
    title: t(
      'Esteban Cambiasso — Argentina vs Serbia & Montenegro, 2006 World Cup',
      'ესტებან კამბიასო — არგენტინა სერბეთი და მონტენეგროსთან, 2006 მუნდიალი'
    ),
    options: [
      opt('a', 'Esteban Cambiasso — Argentina vs Serbia & Montenegro, 2006 World Cup', 'ესტებან კამბიასო — არგენტინა სერბეთი და მონტენეგროსთან, 2006 მუნდიალი', true),
      opt('b', 'Carlos Alberto — Brazil vs Italy, 1970 World Cup final', 'კარლოს ალბერტო — ბრაზილია იტალიასთან, 1970 მუნდიალის ფინალი'),
      opt('c', 'Jack Wilshere — Arsenal vs Norwich, 2013', 'ჯეკ უილშერი — არსენალი ნორვიჩთან, 2013'),
      opt('d', 'Dennis Bergkamp — Arsenal vs Newcastle, 2002', 'დენის ბერგკამპი — არსენალი ნიუკასლთან, 2002'),
    ],
    fun_fact: t(
      "The climax of a 24-pass move — Crespo's blind backheel returned Cambiasso's pass, and Cambiasso lashed it high past Jevrić.",
      '24-პასიანი კომბინაციის კულმინაცია — კრესპოს ბრმა უკუქუსლმა კამბიასოს პასი დაუბრუნა და კამბიასომ ზემო კუთხეში ჩააწვინა.'
    ),
    bonus: {
      question: t('Roughly how many passes did Argentina string together first?', 'დაახლოებით რამდენი პასი გააკეთა არგენტინამ ამ გოლამდე?'),
      options: [
        opt('a', '24', '24', true),
        opt('b', '8', '8'),
        opt('c', '15', '15'),
        opt('d', '31', '31'),
      ],
    },
    players: [
      { id: 'riquelme', team: 'attack', at: [48, 60] },
      { id: 'saviola', team: 'attack', at: [26, 66] },
      { id: 'cambiasso', team: 'attack', at: [38, 70] },
      { id: 'crespo', team: 'attack', at: [37, 88] },
      { id: 'd1', team: 'defense', at: [34, 76] },
      { id: 'd2', team: 'defense', at: [44, 82] },
      { id: 'd3', team: 'defense', at: [30, 90] },
      { id: 'd4', team: 'defense', at: [42, 94] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'pass', player: 'riquelme', to: [27, 66], duration: 1.0 },
      { kind: 'pass', player: 'saviola', to: [38, 71], duration: 0.9 },
      { kind: 'pass', player: 'cambiasso', to: [37, 88], duration: 1.0 },
      { kind: 'run', player: 'cambiasso', to: [36, 84], withPrev: true, duration: 1.0 },
      { kind: 'pass', player: 'crespo', to: [36, 84], duration: 0.7 },
      { kind: 'shot', player: 'cambiasso', to: [33, 105], loft: 0.45, duration: 0.7 },
    ],
    scorer: 'Esteban Cambiasso',
    match_label: 'Argentina vs Serbia and Montenegro, World Cup group stage',
    year: 2006,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'van-basten-euro-1988',
    difficulty: 'medium',
    title: t(
      "Marco van Basten — Netherlands vs USSR, Euro '88 final",
      'მარკო ვან ბასტენი — ნიდერლანდები სსრკ-სთან, ევრო 88-ის ფინალი'
    ),
    options: [
      opt('a', "Marco van Basten — Netherlands vs USSR, Euro '88 final", 'მარკო ვან ბასტენი — ნიდერლანდები სსრკ-სთან, ევრო 88 ფინალი', true),
      opt('b', 'Zinedine Zidane — Real Madrid vs Leverkusen, 2002 final', 'ზინედინ ზიდანი — რეალი ლევერკუზენთან, 2002 ფინალი'),
      opt('c', 'David Trezeguet — France vs Italy, Euro 2000 final', 'დავიდ ტრეზეგე — საფრანგეთი იტალიასთან, ევრო 2000 ფინალი'),
      opt('d', 'Gareth Bale — Real Madrid vs Liverpool, 2018 final', 'გარეთ ბეილი — რეალი ლივერპულთან, 2018 ფინალი'),
    ],
    fun_fact: t(
      'A dipping volley from an absurd angle off Mühren\'s hanging cross — many still call it the greatest goal in a major final.',
      'მიურენის ჩამოკიდებული გადმოცემიდან წარმოუდგენელი კუთხიდან ჩაწეული ვოლეი — დღემდე დიდი ფინალის საუკეთესო გოლად მიიჩნევა.'
    ),
    bonus: {
      question: t('What did Van Basten win that summer besides the trophy?', 'რას მოიგებდა ვან ბასტენი იმ ზაფხულს თასის გარდა?'),
      options: [
        opt('a', 'Top scorer of the tournament', 'ტურნირის საუკეთესო ბომბარდირობა', true),
        opt('b', 'Nothing else', 'სხვას არაფერს'),
        opt('c', 'Best goalkeeper award', 'საუკეთესო მეკარის ჯილდო'),
        opt('d', 'Olympic gold', 'ოლიმპიური ოქრო'),
      ],
    },
    players: [
      { id: 'muhren', team: 'attack', at: [8, 62] },
      { id: 'van_basten', team: 'attack', at: [46, 84] },
      { id: 'gullit', team: 'attack', at: [30, 86] },
      { id: 'd1', team: 'defense', at: [24, 80] },
      { id: 'd2', team: 'defense', at: [36, 90] },
      { id: 'd3', team: 'defense', at: [46, 92] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'carry', player: 'muhren', to: [10, 68], duration: 1.1 },
      { kind: 'pass', player: 'muhren', to: [47, 86], via: [30, 74], loft: 1, duration: 1.8 },
      { kind: 'run', player: 'van_basten', to: [47, 86], withPrev: true, duration: 1.6 },
      { kind: 'shot', player: 'van_basten', to: [31, 104], loft: 0.7, duration: 0.8 },
    ],
    scorer: 'Marco van Basten',
    match_label: 'Netherlands vs USSR, Euro final',
    year: 1988,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'zidane-ucl-final-2002',
    difficulty: 'easy',
    title: t(
      'Zinedine Zidane — Real Madrid vs Leverkusen, 2002 Champions League final',
      'ზინედინ ზიდანი — რეალი ლევერკუზენთან, 2002 ჩემპიონთა ლიგის ფინალი'
    ),
    options: [
      opt('a', 'Zinedine Zidane — Real Madrid vs Leverkusen, 2002 final', 'ზინედინ ზიდანი — რეალი ლევერკუზენთან, 2002 ფინალი', true),
      opt('b', "Marco van Basten — Netherlands vs USSR, Euro '88 final", 'მარკო ვან ბასტენი — ნიდერლანდები სსრკ-სთან, ევრო 88 ფინალი'),
      opt('c', 'Gareth Bale — Real Madrid vs Liverpool, 2018 final', 'გარეთ ბეილი — რეალი ლივერპულთან, 2018 ფინალი'),
      opt('d', 'Cristiano Ronaldo — Real Madrid vs Juventus, 2018', 'კრიშტიანუ რონალდუ — რეალი იუვენტუსთან, 2018'),
    ],
    fun_fact: t(
      "Roberto Carlos's looping left-wing cross dropped over Zidane's shoulder — met first time with the weaker left foot into the top corner.",
      'რობერტო კარლოსის მაღალი გადმოცემა ზიდანს მხარზე გადმოეშვა — პირველივე შეხებით, სუსტი მარცხენათი, ზედა კუთხეში.'
    ),
    bonus: {
      question: t('Which foot did Zidane strike the volley with?', 'რომელი ფეხით ჩაარტყა ზიდანმა ეს ვოლეი?'),
      options: [
        opt('a', 'Left', 'მარცხენა', true),
        opt('b', 'Right', 'მარჯვენა'),
        opt('c', 'It was a header', 'თავით იყო'),
        opt('d', 'Chest then right foot', 'მკერდით და მერე მარჯვენათი'),
      ],
    },
    players: [
      { id: 'roberto_carlos', team: 'attack', at: [6, 70] },
      { id: 'zidane', team: 'attack', at: [36, 84] },
      { id: 'raul', team: 'attack', at: [44, 90] },
      { id: 'd1', team: 'defense', at: [14, 78] },
      { id: 'd2', team: 'defense', at: [30, 90] },
      { id: 'd3', team: 'defense', at: [42, 94] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'carry', player: 'roberto_carlos', to: [7, 82], via: [4, 76], duration: 1.4 },
      { kind: 'pass', player: 'roberto_carlos', to: [36, 86], via: [20, 88], loft: 1, duration: 1.7 },
      { kind: 'shot', player: 'zidane', to: [31, 104], loft: 0.6, duration: 0.7 },
    ],
    scorer: 'Zinedine Zidane',
    match_label: 'Real Madrid vs Bayer Leverkusen, Champions League final',
    year: 2002,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'roberto-carlos-france-1997',
    difficulty: 'easy',
    title: t(
      'Roberto Carlos — Brazil vs France, 1997 (the impossible free kick)',
      'რობერტო კარლოსი — ბრაზილია საფრანგეთთან, 1997 (შეუძლებელი შტრაფი)'
    ),
    options: [
      opt('a', 'Roberto Carlos — Brazil vs France, 1997', 'რობერტო კარლოსი — ბრაზილია საფრანგეთთან, 1997', true),
      opt('b', 'Ronaldinho — Brazil vs England, 2002', 'რონალდინიო — ბრაზილია ინგლისთან, 2002'),
      opt('c', 'David Beckham — England vs Greece, 2001', 'დევიდ ბექჰემი — ინგლისი საბერძნეთთან, 2001'),
      opt('d', 'Cristiano Ronaldo — Portugal vs Spain, 2018', 'კრიშტიანუ რონალდუ — პორტუგალია ესპანეთთან, 2018'),
    ],
    fun_fact: t(
      'The banana free kick from 35 metres that bent around the wall so far the ball-boy behind the goal ducked — physicists wrote papers about it.',
      '35 მეტრიდან "ბანანივით" მოხვეული შტრაფი, რომელზეც კარს უკან მდგომი ბიჭიც კი დაიხარა — ფიზიკოსებმა ნაშრომებიც კი მიუძღვნეს.'
    ),
    bonus: {
      question: t('Which tournament hosted this free kick?', 'რომელ ტურნირზე გაიტანეს ეს შტრაფი?'),
      options: [
        opt('a', 'Tournoi de France', 'საფრანგეთის ტურნირი (Tournoi)', true),
        opt('b', '1998 World Cup', '1998 მუნდიალი'),
        opt('c', 'Copa América', 'კოპა ამერიკა'),
        opt('d', 'Confederations Cup', 'კონფედერაციების თასი'),
      ],
    },
    players: [
      { id: 'roberto_carlos', team: 'attack', at: [34, 68] },
      { id: 'ronaldo', team: 'attack', at: [44, 82] },
      { id: 'wall1', team: 'defense', at: [30, 78] },
      { id: 'wall2', team: 'defense', at: [33, 78] },
      { id: 'wall3', team: 'defense', at: [36, 78] },
      { id: 'gk', team: 'keeper', at: [34, 103] },
    ],
    steps: [
      { kind: 'carry', player: 'roberto_carlos', to: [34, 70], duration: 1.4 },
      { kind: 'shot', player: 'roberto_carlos', to: [37, 104], via: [48, 87], loft: 0.5, duration: 1.8 },
    ],
    scorer: 'Roberto Carlos',
    match_label: 'Brazil vs France, Tournoi de France',
    year: 1997,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'beckham-wimbledon-1996',
    difficulty: 'easy',
    title: t(
      'David Beckham — Man United vs Wimbledon, 1996 (from halfway)',
      'დევიდ ბექჰემი — მანჩესტერ იუნაიტედი უიმბლდონთან, 1996 (ცენტრიდან)'
    ),
    options: [
      opt('a', 'David Beckham — Man United vs Wimbledon, 1996', 'დევიდ ბექჰემი — მან. იუნაიტედი უიმბლდონთან, 1996', true),
      opt('b', 'Xabi Alonso — Liverpool vs Newcastle, 2006', 'ხაბი ალონსო — ლივერპული ნიუკასლთან, 2006'),
      opt('c', 'Wayne Rooney — Man United vs West Ham, 2014', 'უეინ რუნი — მან. იუნაიტედი ვესტ ჰემთან, 2014'),
      opt('d', 'Charlie Adam — Stoke vs Chelsea, 2015', 'ჩარლი ადამი — სტოუკი ჩელსისთან, 2015'),
    ],
    fun_fact: t(
      "Opening day of the 1996-97 season: a 21-year-old spotted the keeper off his line and announced himself to the world from his own half.",
      '1996-97 სეზონის პირველ ტურში 21 წლის ბექჰემმა კარიდან გამოსული მეკარე შენიშნა და საკუთარი ნახევრიდან გაუგზავნა მსოფლიოს სავიზიტო ბარათი.'
    ),
    bonus: {
      question: t('Who was the Wimbledon keeper lobbed that day?', 'რომელი მეკარე გადაუგდეს იმ დღეს?'),
      options: [
        opt('a', 'Neil Sullivan', 'ნილ სალივანი', true),
        opt('b', 'David Seaman', 'დევიდ სიმენი'),
        opt('c', 'Peter Schmeichel', 'პეტერ შმაიხელი'),
        opt('d', 'Nigel Martyn', 'ნაიჯელ მარტინი'),
      ],
    },
    players: [
      { id: 'beckham', team: 'attack', at: [30, 48] },
      { id: 'cantona', team: 'attack', at: [40, 70] },
      { id: 'd1', team: 'defense', at: [30, 60] },
      { id: 'd2', team: 'defense', at: [40, 80] },
      { id: 'gk', team: 'keeper', at: [34, 92] },
    ],
    steps: [
      { kind: 'carry', player: 'beckham', to: [32, 52], duration: 1.4 },
      { kind: 'shot', player: 'beckham', to: [35, 104], loft: 1, duration: 2.0 },
    ],
    scorer: 'David Beckham',
    match_label: 'Manchester United vs Wimbledon, Premier League',
    year: 1996,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'ibrahimovic-england-2012',
    difficulty: 'easy',
    title: t(
      'Zlatan Ibrahimović — Sweden vs England, 2012 (30-yard bicycle kick)',
      'ზლატან იბრაჰიმოვიჩი — შვედეთი ინგლისთან, 2012 (30-იარდიანი "მაკრატელა")'
    ),
    options: [
      opt('a', 'Zlatan Ibrahimović — Sweden vs England, 2012', 'ზლატან იბრაჰიმოვიჩი — შვედეთი ინგლისთან, 2012', true),
      opt('b', 'Wayne Rooney — Man United vs Man City, 2011', 'უეინ რუნი — მან. იუნაიტედი მან. სიტისთან, 2011'),
      opt('c', 'Cristiano Ronaldo — Real Madrid vs Juventus, 2018', 'კრიშტიანუ რონალდუ — რეალი იუვენტუსთან, 2018'),
      opt('d', 'Olivier Giroud — Arsenal vs Crystal Palace, 2017', 'ოლივიე ჟირუ — არსენალი კრისტალ პალასთან, 2017'),
    ],
    fun_fact: t(
      "Joe Hart's headed clearance dropped out of the night sky and Zlatan hit a 30-yard overhead — his fourth goal of the game, in a brand-new stadium.",
      'ჯო ჰარტის თავით გატანილი ბურთი ღამის ციდან ჩამოეშვა და ზლატანმა 30 იარდიდან "მაკრატელათი" ჩააწვინა — მისი მეოთხე გოლი იმ მატჩში.'
    ),
    bonus: {
      question: t('How many goals did Zlatan score in that match?', 'სულ რამდენი გოლი გაიტანა ზლატანმა იმ მატჩში?'),
      options: [
        opt('a', '4', '4', true),
        opt('b', '2', '2'),
        opt('c', '3', '3'),
        opt('d', '5', '5'),
      ],
    },
    players: [
      { id: 'zlatan', team: 'attack', at: [38, 82] },
      { id: 'kallstrom', team: 'attack', at: [24, 60] },
      { id: 'd1', team: 'defense', at: [30, 88] },
      { id: 'd2', team: 'defense', at: [42, 90] },
      { id: 'gk', team: 'keeper', at: [36, 96] },
    ],
    steps: [
      { kind: 'pass', player: 'kallstrom', to: [40, 76], via: [34, 90], loft: 1, duration: 1.9 },
      { kind: 'run', player: 'zlatan', to: [41, 76], withPrev: true, duration: 1.6 },
      { kind: 'shot', player: 'zlatan', to: [33, 104], loft: 0.8, duration: 1.4 },
    ],
    scorer: 'Zlatan Ibrahimović',
    match_label: 'Sweden vs England, international friendly',
    year: 2012,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'rooney-derby-2011',
    difficulty: 'easy',
    title: t(
      'Wayne Rooney — Man United vs Man City, 2011 (derby bicycle kick)',
      'უეინ რუნი — მან. იუნაიტედი მან. სიტისთან, 2011 (დერბის "მაკრატელა")'
    ),
    options: [
      opt('a', 'Wayne Rooney — Man United vs Man City, 2011', 'უეინ რუნი — მან. იუნაიტედი მან. სიტისთან, 2011', true),
      opt('b', 'Zlatan Ibrahimović — Sweden vs England, 2012', 'ზლატან იბრაჰიმოვიჩი — შვედეთი ინგლისთან, 2012'),
      opt('c', 'Gareth Bale — Real Madrid vs Liverpool, 2018 final', 'გარეთ ბეილი — რეალი ლივერპულთან, 2018 ფინალი'),
      opt('d', 'Peter Crouch — Liverpool vs Galatasaray, 2006', 'პიტერ კრაუჩი — ლივერპული გალატასარაისთან, 2006'),
    ],
    fun_fact: t(
      "Nani's deflected cross arrived behind Rooney — he adjusted mid-air and put an overhead into the top corner to win the Manchester derby.",
      'ნანის რიკოშეტით შეცვლილი გადმოცემა რუნის ზურგს უკან აღმოჩნდა — ჰაერში გასწორდა და "მაკრატელათი" ზედა კუთხეში ჩააწვინა დერბის მოსაგებად.'
    ),
    bonus: {
      question: t('Who delivered the deflected cross?', 'ვისი გადმოცემა იყო?'),
      options: [
        opt('a', 'Nani', 'ნანი', true),
        opt('b', 'Ryan Giggs', 'რაიან გიგზი'),
        opt('c', 'Antonio Valencia', 'ანტონიო ვალენსია'),
        opt('d', 'Patrice Evra', 'პატრის ევრა'),
      ],
    },
    players: [
      { id: 'nani', team: 'attack', at: [52, 78] },
      { id: 'rooney', team: 'attack', at: [37, 90] },
      { id: 'berbatov', team: 'attack', at: [30, 88] },
      { id: 'd1', team: 'defense', at: [44, 86] },
      { id: 'd2', team: 'defense', at: [32, 92] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'carry', player: 'nani', to: [50, 84], duration: 1.2 },
      { kind: 'pass', player: 'nani', to: [38, 92], via: [44, 92], loft: 0.8, duration: 1.1 },
      { kind: 'shot', player: 'rooney', to: [31, 104], loft: 0.8, duration: 0.9 },
    ],
    scorer: 'Wayne Rooney',
    match_label: 'Manchester United vs Manchester City, Premier League',
    year: 2011,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'aguero-qpr-2012',
    difficulty: 'easy',
    title: t(
      'Sergio Agüero — Man City vs QPR, 2012 (93:20, the title winner)',
      'სერხიო აგუერო — მან. სიტი QPR-თან, 2012 (93:20, ჩემპიონობის გოლი)'
    ),
    options: [
      opt('a', 'Sergio Agüero — Man City vs QPR, 2012', 'სერხიო აგუერო — მან. სიტი QPR-თან, 2012', true),
      opt('b', 'Vincent Kompany — Man City vs Leicester, 2019', 'ვენსან კომპანი — მან. სიტი ლესტერთან, 2019'),
      opt('c', 'Michael Thomas — Arsenal vs Liverpool, 1989', 'მაიკლ ტომასი — არსენალი ლივერპულთან, 1989'),
      opt('d', 'Didier Drogba — Chelsea vs Bayern, 2012 final', 'დიდიე დროგბა — ჩელსი ბაერნთან, 2012 ფინალი'),
    ],
    fun_fact: t(
      '"AGUERO000000!" — 93 minutes 20 seconds, the last kick swing of the season, City\'s first league title in 44 years snatched from United.',
      '"AGUEROOOO!" — 93:20, სეზონის უკანასკნელი შეტევა და სიტის პირველი ჩემპიონობა 44 წლის შემდეგ, იუნაიტედს ხელიდან გამოგლეჯილი.'
    ),
    bonus: {
      question: t('Who cushioned the final pass into Agüero?', 'ვინ გააწოდა ბოლო პასი აგუეროსთვის?'),
      options: [
        opt('a', 'Mario Balotelli', 'მარიო ბალოტელი', true),
        opt('b', 'David Silva', 'დავიდ სილვა'),
        opt('c', 'Edin Džeko', 'ედინ ჯეკო'),
        opt('d', 'Carlos Tevez', 'კარლოს ტევესი'),
      ],
    },
    players: [
      { id: 'de_jong', team: 'attack', at: [34, 45] },
      { id: 'aguero', team: 'attack', at: [40, 72] },
      { id: 'balotelli', team: 'attack', at: [36, 86] },
      { id: 'd1', team: 'defense', at: [30, 78] },
      { id: 'd2', team: 'defense', at: [42, 88] },
      { id: 'd3', team: 'defense', at: [34, 94] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'carry', player: 'de_jong', to: [36, 62], duration: 1.6 },
      { kind: 'pass', player: 'de_jong', to: [41, 74], duration: 0.9 },
      { kind: 'carry', player: 'aguero', to: [38, 84], duration: 1.1 },
      { kind: 'pass', player: 'aguero', to: [37, 87], duration: 0.6 },
      { kind: 'run', player: 'aguero', to: [42, 88], withPrev: true, duration: 0.6 },
      { kind: 'pass', player: 'balotelli', to: [42, 89], duration: 0.6 },
      { kind: 'carry', player: 'aguero', to: [39, 95], duration: 0.8 },
      { kind: 'shot', player: 'aguero', to: [36, 104], duration: 0.6 },
    ],
    scorer: 'Sergio Agüero',
    match_label: 'Manchester City vs QPR, Premier League final day',
    year: 2012,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'giggs-arsenal-1999',
    difficulty: 'medium',
    title: t(
      'Ryan Giggs — Man United vs Arsenal, 1999 FA Cup semi-final',
      'რაიან გიგზი — მან. იუნაიტედი არსენალთან, 1999 FA Cup ნახევარფინალი'
    ),
    options: [
      opt('a', 'Ryan Giggs — Man United vs Arsenal, 1999', 'რაიან გიგზი — მან. იუნაიტედი არსენალთან, 1999', true),
      opt('b', 'George Weah — AC Milan vs Verona, 1996', 'ჯორჯ ვეა — მილანი ვერონასთან, 1996'),
      opt('c', 'Michael Owen — England vs Argentina, 1998', 'მაიკლ ოუენი — ინგლისი არგენტინასთან, 1998'),
      opt('d', 'Diego Maradona — Argentina vs England, 1986', 'დიეგო მარადონა — არგენტინა ინგლისთან, 1986'),
    ],
    fun_fact: t(
      'Extra time, ten men, an interception from Vieira — then a slalom through the entire Arsenal defence and a rocket past Seaman, shirt off, hairy chest to the world.',
      'დამატებითი დრო, 10 კაცი, ვიეირასგან წართმეული ბურთი — მერე მთელი არსენალის დაცვის სლალომით გავლა და "რაკეტა" სიმენს, ბოლოს კი მოხდილი მაისური.'
    ),
    bonus: {
      question: t('Whose loose pass did Giggs intercept to start the run?', 'ვისი პასი დაიჭირა გიგზმა სლალომის დასაწყებად?'),
      options: [
        opt('a', 'Patrick Vieira', 'პატრიკ ვიეირა', true),
        opt('b', 'Emmanuel Petit', 'ემანუელ პეტი'),
        opt('c', 'Tony Adams', 'ტონი ადამსი'),
        opt('d', 'Dennis Bergkamp', 'დენის ბერგკამპი'),
      ],
    },
    players: [
      { id: 'giggs', team: 'attack', at: [28, 42] },
      { id: 'yorke', team: 'attack', at: [40, 80] },
      { id: 'd1', team: 'defense', at: [32, 52] },
      { id: 'd2', team: 'defense', at: [26, 66] },
      { id: 'd3', team: 'defense', at: [34, 78] },
      { id: 'd4', team: 'defense', at: [28, 90] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'carry', player: 'giggs', to: [30, 60], via: [36, 50], duration: 1.6 },
      { kind: 'carry', player: 'giggs', to: [28, 76], via: [22, 68], duration: 1.5 },
      { kind: 'carry', player: 'giggs', to: [31, 92], via: [36, 84], duration: 1.4 },
      { kind: 'shot', player: 'giggs', to: [32, 104], loft: 0.8, duration: 0.6 },
    ],
    scorer: 'Ryan Giggs',
    match_label: 'Manchester United vs Arsenal, FA Cup semi-final replay',
    year: 1999,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'owen-argentina-1998',
    difficulty: 'medium',
    title: t(
      'Michael Owen — England vs Argentina, 1998 World Cup',
      'მაიკლ ოუენი — ინგლისი არგენტინასთან, 1998 მუნდიალი'
    ),
    options: [
      opt('a', 'Michael Owen — England vs Argentina, 1998', 'მაიკლ ოუენი — ინგლისი არგენტინასთან, 1998', true),
      opt('b', 'Ryan Giggs — Man United vs Arsenal, 1999', 'რაიან გიგზი — მან. იუნაიტედი არსენალთან, 1999'),
      opt('c', 'Kylian Mbappé — France vs Argentina, 2018', 'კილიან ემბაპე — საფრანგეთი არგენტინასთან, 2018'),
      opt('d', 'Kaká — AC Milan vs Man United, 2007', 'კაკა — მილანი მან. იუნაიტედთან, 2007'),
    ],
    fun_fact: t(
      'An 18-year-old took one touch from Beckham, burned past Chamot and Ayala, and lifted it over the keeper — England had a superstar.',
      '18 წლის ოუენმა ბექჰემის პასს ერთი შეხებით უპასუხა, ჩამოტს და აიალას ჩაუარა და მეკარეს ზემოდან გადაუგდო — ინგლისს ვარსკვლავი გაუჩნდა.'
    ),
    bonus: {
      question: t('How old was Owen when he scored this?', 'რამდენი წლის იყო ოუენი ამ გოლისას?'),
      options: [
        opt('a', '18', '18', true),
        opt('b', '17', '17'),
        opt('c', '19', '19'),
        opt('d', '21', '21'),
      ],
    },
    players: [
      { id: 'beckham', team: 'attack', at: [36, 50] },
      { id: 'owen', team: 'attack', at: [42, 58] },
      { id: 'scholes', team: 'attack', at: [26, 78] },
      { id: 'chamot', team: 'defense', at: [44, 68] },
      { id: 'ayala', team: 'defense', at: [36, 82] },
      { id: 'gk', team: 'keeper', at: [34, 101] },
    ],
    steps: [
      { kind: 'pass', player: 'beckham', to: [43, 60], duration: 0.8 },
      { kind: 'carry', player: 'owen', to: [41, 80], via: [47, 70], duration: 1.7 },
      { kind: 'carry', player: 'owen', to: [37, 92], via: [41, 87], duration: 1.2 },
      { kind: 'shot', player: 'owen', to: [37, 104], loft: 0.5, duration: 0.7 },
    ],
    scorer: 'Michael Owen',
    match_label: 'England vs Argentina, World Cup round of 16',
    year: 1998,
    goal_ordinal: 1,
    schema_version: 1,
  },
  {
    slug: 'weah-verona-1996',
    difficulty: 'hard',
    title: t(
      'George Weah — AC Milan vs Verona, 1996 (box-to-box solo)',
      'ჯორჯ ვეა — მილანი ვერონასთან, 1996 (კარიდან კარამდე)'
    ),
    options: [
      opt('a', 'George Weah — AC Milan vs Verona, 1996', 'ჯორჯ ვეა — მილანი ვერონასთან, 1996', true),
      opt('b', 'Diego Maradona — Argentina vs England, 1986', 'დიეგო მარადონა — არგენტინა ინგლისთან, 1986'),
      opt('c', 'Ronaldo — Barcelona vs Compostela, 1996', 'რონალდო — ბარსელონა კომპოსტელასთან, 1996'),
      opt('d', 'Son Heung-min — Tottenham vs Burnley, 2020', 'სონ ჰიუნ-მინი — ტოტენჰემი ბერნლისთან, 2020'),
    ],
    fun_fact: t(
      'Cleared a corner from his own six-yard box, then ran the full length of San Siro through seven Verona players. The reigning Ballon d\'Or holder, proving why.',
      'კუთხურიდან ბურთი საკუთარ კარის წინ დაიჭირა და მთელი "სან სირო" გაირბინა შვიდი ვერონელის გვერდის ავლით. მოქმედი "ოქროს ბურთის" მფლობელი საქმეში.'
    ),
    bonus: {
      question: t('What had Weah won a few months earlier?', 'რა მოიგო ვეამ ამ გოლამდე რამდენიმე თვით ადრე?'),
      options: [
        opt('a', "The Ballon d'Or", '"ოქროს ბურთი"', true),
        opt('b', 'The Champions League', 'ჩემპიონთა ლიგა'),
        opt('c', 'The World Cup', 'მუნდიალი'),
        opt('d', 'The Africa Cup of Nations', 'აფრიკის თასი'),
      ],
    },
    players: [
      { id: 'weah', team: 'attack', at: [30, 8] },
      { id: 'baggio', team: 'attack', at: [44, 60] },
      { id: 'd1', team: 'defense', at: [34, 30] },
      { id: 'd2', team: 'defense', at: [28, 48] },
      { id: 'd3', team: 'defense', at: [38, 66] },
      { id: 'd4', team: 'defense', at: [32, 84] },
      { id: 'd5', team: 'defense', at: [40, 92] },
      { id: 'gk', team: 'keeper', at: [34, 102] },
    ],
    steps: [
      { kind: 'carry', player: 'weah', to: [32, 38], via: [26, 24], duration: 2.0 },
      { kind: 'carry', player: 'weah', to: [34, 62], via: [40, 50], duration: 1.8 },
      { kind: 'carry', player: 'weah', to: [36, 88], via: [30, 76], duration: 1.8 },
      { kind: 'shot', player: 'weah', to: [32, 104], duration: 0.7 },
    ],
    scorer: 'George Weah',
    match_label: 'AC Milan vs Verona, Serie A',
    year: 1996,
    goal_ordinal: 1,
    schema_version: 1,
  },
];
