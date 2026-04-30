import type { DailyChallengeDefinition, DailyChallengeType } from './daily-challenges.types.js';

export const DAILY_CHALLENGE_DEFINITIONS: Record<DailyChallengeType, DailyChallengeDefinition> = {
  moneyDrop: {
    challengeType: 'moneyDrop',
    title: {
      en: 'Money Drop',
      ka: 'ფულის ვარდნა',
    },
    description: {
      en: 'Answer real football trivia and keep as much cash on the right answer as you can.',
      ka: 'უპასუხე საფეხბურთო კითხვებს და სწორ პასუხზე რაც შეიძლება მეტი თანხა შეინარჩუნე.',
    },
    iconToken: 'dollarSign',
  },
  trueFalse: {
    challengeType: 'trueFalse',
    title: {
      en: 'True or False',
      ka: 'მართალია თუ მცდარი',
    },
    description: {
      en: 'Read each football statement and decide whether it is true or false.',
      ka: 'წაიკითხე საფეხბურთო წინადადება და გადაწყვიტე, მართალია თუ მცდარი.',
    },
    iconToken: 'checkCircle',
  },
  clues: {
    challengeType: 'clues',
    title: {
      en: 'Clues Challenge',
      ka: 'მინიშნებების გამოწვევა',
    },
    description: {
      en: 'Solve each football clue chain before the later hints give it away.',
      ka: 'გამოიცანი პასუხი მინიშნებების ჯაჭვიდან, სანამ ბოლო მინიშნებები ყველაფერს გაამარტივებს.',
    },
    iconToken: 'lightbulb',
  },
  countdown: {
    challengeType: 'countdown',
    title: {
      en: 'Countdown Challenge',
      ka: 'უკუთვლის გამოწვევა',
    },
    description: {
      en: 'Beat the clock and type as many valid answers as you can each round.',
      ka: 'დროის ამოწურვამდე ჩაწერე რაც შეიძლება მეტი სწორი პასუხი თითოეულ რაუნდში.',
    },
    iconToken: 'timer',
  },
  putInOrder: {
    challengeType: 'putInOrder',
    title: {
      en: 'Put in Order',
      ka: 'დაალაგე რიგით',
    },
    description: {
      en: 'Drag football events into the correct order.',
      ka: 'გადაიტანე საფეხბურთო მოვლენები სწორ თანმიმდევრობაში.',
    },
    iconToken: 'list',
  },
  imposter: {
    challengeType: 'imposter',
    title: {
      en: 'Imposter',
      ka: 'იმპოსტერი',
    },
    description: {
      en: 'Spot the imposters and submit the exact set of correct football answers.',
      ka: 'იპოვე ზედმეტები და გაგზავნე ზუსტად სწორი საფეხბურთო პასუხების სეტი.',
    },
    iconToken: 'users',
  },
  careerPath: {
    challengeType: 'careerPath',
    title: {
      en: 'Career Path',
      ka: 'კარიერის გზა',
    },
    description: {
      en: 'Read the club path and identify the player behind the journey.',
      ka: 'წაიკითხე კლუბების გზა და გამოიცანი ფეხბურთელი.',
    },
    iconToken: 'route',
  },
  highLow: {
    challengeType: 'highLow',
    title: {
      en: 'High Low',
      ka: 'მეტი თუ ნაკლები',
    },
    description: {
      en: 'Pick the higher stat in each football matchup and keep the chain alive.',
      ka: 'აირჩიე უფრო მაღალი მაჩვენებელი თითოეულ წყვილში და შეინარჩუნე ჯაჭვი.',
    },
    iconToken: 'trendingUp',
  },
  footballLogic: {
    challengeType: 'footballLogic',
    title: {
      en: 'Football Logic',
      ka: 'საფეხბურთო ლოგიკა',
    },
    description: {
      en: 'Use the visual clues to decode the footballer, match, or moment.',
      ka: 'გამოიყენე ვიზუალური მინიშნებები ფეხბურთელის, მატჩის ან მომენტის გამოსაცნობად.',
    },
    iconToken: 'image',
  },
};
