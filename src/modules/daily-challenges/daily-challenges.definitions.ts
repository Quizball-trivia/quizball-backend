import type { DailyChallengeDefinition, DailyChallengeType } from './daily-challenges.types.js';

export const DAILY_CHALLENGE_DEFINITIONS: Record<DailyChallengeType, DailyChallengeDefinition> = {
  moneyDrop: {
    challengeType: 'moneyDrop',
    title: {
      en: 'Money Drop',
      ka: 'ფულის ვარდნა',
      tr: 'Money Drop',
    },
    description: {
      en: 'Answer real football trivia and keep as much cash on the right answer as you can.',
      ka: 'უპასუხე საფეხბურთო კითხვებს და სწორ პასუხზე რაც შეიძლება მეტი თანხა შეინარჩუნე.',
      tr: 'Gerçek futbol sorularını yanıtla ve doğru cevapta olabildiğince çok para tut.',
    },
    iconToken: 'dollarSign',
  },
  trueFalse: {
    challengeType: 'trueFalse',
    title: {
      en: 'True or False',
      ka: 'მართალი თუ მცდარი',
      tr: 'Doğru mu Yanlış mı',
    },
    description: {
      en: 'Read each fact and decide whether it is true or false.',
      ka: 'წაიკითხე ფაქტი და გადაწყვიტე, მართალია თუ მცდარი.',
      tr: 'Her bilgiyi oku ve doğru mu yanlış mı olduğuna karar ver.',
    },
    iconToken: 'checkCircle',
  },
  clues: {
    challengeType: 'clues',
    title: {
      en: 'Who Am I?',
      ka: 'ვინ ვარ მე?',
      tr: 'Ben Kimim?',
    },
    description: {
      en: 'Solve each football clue chain before the later hints give it away.',
      ka: 'გამოიცანი პასუხი მინიშნებების ჯაჭვიდან, სანამ ბოლო მინიშნებები ყველაფერს გაამარტივებს.',
      tr: 'Sonraki ipuçları cevabı ele vermeden her futbol ipucu zincirini çöz.',
    },
    iconToken: 'lightbulb',
  },
  countdown: {
    challengeType: 'countdown',
    title: {
      en: 'Countdown Challenge',
      ka: 'უკუთვლა',
      tr: 'Countdown Görevi',
    },
    description: {
      en: 'Beat the clock and type as many valid answers as you can each round.',
      ka: 'დროის ამოწურვამდე ჩაწერე რაც შეიძლება მეტი სწორი პასუხი თითოეულ რაუნდში.',
      tr: 'Zamana karşı yarış ve her turda olabildiğince çok geçerli cevap yaz.',
    },
    iconToken: 'timer',
  },
  putInOrder: {
    challengeType: 'putInOrder',
    title: {
      en: 'Put in Order',
      ka: 'დაალაგე რიგის მიხედვით',
      tr: 'Sıraya Koy',
    },
    description: {
      en: 'Drag football events into the correct order.',
      ka: 'დაალაგე საფეხბურთო მოვლენები სწორი თანმიმდევრობით.',
      tr: 'Futbol olaylarını doğru sıraya sürükle.',
    },
    iconToken: 'list',
  },
  imposter: {
    challengeType: 'imposter',
    // Display name rebranded to "Pick'em" — the internal challengeType key
    // stays `imposter` for API/DB compatibility.
    title: {
      en: "Pick'em",
      ka: "Pick'em",
      tr: 'Seç',
    },
    description: {
      en: 'Pick the exact set of correct answers.',
      ka: 'აირჩიე ზუსტად სწორი პასუხების სია.',
      tr: 'Doğru cevapların tam kümesini seç.',
    },
    iconToken: 'users',
  },
  careerPath: {
    challengeType: 'careerPath',
    title: {
      en: 'Career Path',
      ka: 'კარიერის გზა',
      tr: 'Kariyer Yolu',
    },
    description: {
      en: 'Read the club path and identify the player behind the journey.',
      ka: 'წაიკითხე კლუბების გზა და გამოიცანი რომელი ფეხბურთელის კარიერას აღნიშნავს.',
      tr: 'Kulüp yolunu oku ve bu yolculuğun arkasındaki oyuncuyu bul.',
    },
    iconToken: 'route',
  },
  highLow: {
    challengeType: 'highLow',
    title: {
      en: 'High Low',
      ka: 'მეტი თუ ნაკლები',
      tr: 'Yüksek Düşük',
    },
    description: {
      en: 'Pick the higher stat in each football matchup and keep the chain alive.',
      ka: 'აირჩიე უფრო მაღალი მაჩვენებელი თითოეულ წყვილში და შეინარჩუნე ჯაჭვი.',
      tr: 'Her futbol eşleşmesinde daha yüksek istatistiği seç ve zinciri sürdür.',
    },
    iconToken: 'trendingUp',
  },
  footballLogic: {
    challengeType: 'footballLogic',
    title: {
      en: 'Football Logic',
      ka: 'საფეხბურთო ლოგიკა',
      tr: 'Futbol Mantığı',
    },
    description: {
      en: 'Use the visual clues to decode the footballer, match, or moment.',
      ka: 'გამოიყენე ვიზუალური მინიშნებები ფეხბურთელის, მატჩის ან მომენტის გამოსაცნობად.',
      tr: 'Görsel ipuçlarını kullanarak futbolcuyu, maçı veya anı çöz.',
    },
    iconToken: 'image',
  },
  missingXi: {
    challengeType: 'missingXi',
    title: {
      en: 'Missing XI',
      ka: 'დაკარგული XI',
      tr: 'Eksik XI',
    },
    description: {
      en: 'Three famous line-ups a day. Tap a shirt and name the player who started there.',
      ka: 'დღეში სამი ცნობილი შემადგენლობა. დააჭირე მაისურს და დაასახელე, ვინ დაიწყო იქ.',
      tr: 'Günde üç ünlü kadro. Bir formaya dokun ve orada başlayan oyuncuyu söyle.',
    },
    iconToken: 'users',
  },
  passChain: {
    challengeType: 'passChain',
    title: {
      en: 'Pass Chain',
      ka: 'პასების ჯაჭვი',
      tr: 'Pas Zinciri',
    },
    description: {
      en: 'Link two players through team-mates who shared a club. Fewer links score higher.',
      ka: 'დააკავშირე ორი ფეხბურთელი საერთო კლუბის თანაგუნდელებით. ნაკლები რგოლი — მეტი ქულა.',
      tr: 'İki oyuncuyu aynı kulüpte oynamış takım arkadaşları üzerinden bağla. Daha az halka daha yüksek puan.',
    },
    iconToken: 'route',
  },
  statSniper: {
    challengeType: 'statSniper',
    title: {
      en: 'Stat Sniper',
      ka: 'სტატ-სნაიპერი',
      tr: 'Stat Sniper',
    },
    description: {
      en: 'Ten football numbers a day. Slide to your best guess — the closer you land, the higher you score.',
      ka: 'დღეში ათი ფეხბურთის რიცხვი. მიიტანე სლაიდერი შენს ვარაუდამდე — რაც უფრო ახლოს, მით მეტი ქულა.',
      tr: 'Günde on futbol sayısı. En iyi tahminine kaydır — ne kadar yaklaşırsan o kadar yüksek puan.',
    },
    iconToken: 'trendingUp',
  },
  fifaCards: {
    challengeType: 'fifaCards',
    title: {
      en: 'FIFA Cards',
      ka: 'FIFA ბარათები',
      tr: 'FIFA Kartları',
    },
    description: {
      en: 'A gold card, stats only — name the player before the clues run out.',
      ka: 'ოქროს ბარათი მხოლოდ სტატისტიკით — გამოიცანი მოთამაშე, სანამ მინიშნებები ამოიწურება.',
      tr: 'Altın bir kart, yalnızca istatistikler — ipuçları bitmeden oyuncuyu söyle.',
    },
    iconToken: 'cards',
  },
  cardDetective: {
    challengeType: 'cardDetective',
    title: {
      en: 'Card Detective',
      ka: 'ბარათის დეტექტივი',
      tr: 'Kart Dedektifi',
    },
    description: {
      en: 'Everything hidden, 100 clue coins — name the player using the least information.',
      ka: 'ყველაფერი დამალულია, 100 მინიშნების ქოინი — გამოიცანი მოთამაშე მინიმალური ინფორმაციით.',
      tr: 'Her şey gizli, 100 ipucu jetonu — en az bilgiyle oyuncuyu söyle.',
    },
    iconToken: 'cards',
  },
};
