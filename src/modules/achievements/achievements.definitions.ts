import type { AchievementDefinition } from './achievements.types.js';

export const ACHIEVEMENT_DEFINITIONS: readonly AchievementDefinition[] = [
  {
    id: 'debut_match',
    title: { en: 'Debut Match', ka: 'სადებიუტო მატჩი', ru: 'Дебютный матч', pt: 'Partida de estreia', de: 'Debüt-Match' },
    description: { en: 'Complete your first match.', ka: 'დაასრულე შენი პირველი მატჩი.', ru: 'Заверши свой первый матч.', pt: 'Complete sua primeira partida.', de: 'Schließe dein erstes Match ab.' },
    icon: 'Trophy',
    target: 1,
  },
  {
    id: 'hat_trick_hero',
    title: { en: 'Hat-Trick Hero', ka: 'ჰეთ-ტრიკის გმირი', ru: 'Герой хет-трика', pt: 'Herói do hat-trick', de: 'Hattrick-Held' },
    description: { en: 'Finish a match with every answer correct.', ka: 'დაასრულე მატჩი ყველა სწორი პასუხით.', ru: 'Закончи матч, ответив правильно на все вопросы.', pt: 'Termine uma partida acertando todas as respostas.', de: 'Beende ein Match mit allen richtigen Antworten.' },
    icon: 'Star',
    target: 1,
  },
  {
    id: 'lightning_counter',
    title: { en: 'Lightning Counter', ka: 'ელვის სისწრაფე', ru: 'Молниеносный ответ', pt: 'Resposta relâmpago', de: 'Blitzantwort' },
    description: { en: 'Answer a question correctly in under 2 seconds.', ka: 'უპასუხე კითხვას სწორად 2 წამზე ნაკლებში.', ru: 'Правильно ответь на вопрос меньше чем за 2 секунды.', pt: 'Acerte uma pergunta em menos de 2 segundos.', de: 'Beantworte eine Frage in unter 2 Sekunden richtig.' },
    icon: 'Zap',
    target: 1,
  },
  {
    id: 'clean_sheet',
    title: { en: 'Clean Sheet', ka: 'სუფთა ფურცელი', ru: 'Сухой матч', pt: 'Partida sem sofrer gols', de: 'Zu null' },
    description: { en: 'Win a possession match without conceding a goal.', ka: 'მოიგე ფლობის მატჩი გოლის მიღების გარეშე.', ru: 'Выиграй матч за владение мячом, не пропустив ни одного гола.', pt: 'Vença uma partida de posse de bola sem sofrer gols.', de: 'Gewinne ein Ballbesitz-Match, ohne ein Tor zu kassieren.' },
    icon: 'Trophy',
    target: 1,
  },
  {
    id: 'winning_streak',
    title: { en: 'Winning Streak', ka: 'მოგების სერია', ru: 'Серия побед', pt: 'Sequência de vitórias', de: 'Siegesserie' },
    description: { en: 'Reach a 5-match win streak.', ka: 'მიაღწიე 5-მატჩიან მოგების სერიას.', ru: 'Выиграй 5 матчей подряд.', pt: 'Vença 5 partidas seguidas.', de: 'Erreiche eine Siegesserie von 5 Matches.' },
    icon: 'Flame',
    target: 5,
  },
  {
    id: 'multiplayer_master',
    title: { en: 'Multiplayer Master', ka: 'მრავალმოთამაშის ოსტატი', ru: 'Мастер мультиплеера', pt: 'Mestre do multiplayer', de: 'Multiplayer-Meister' },
    description: { en: 'Win 10 matches in QuizBall.', ka: 'მოიგე 10 მატჩი QuizBall-ში.', ru: 'Выиграй 10 матчей в QuizBall.', pt: 'Vença 10 partidas no QuizBall.', de: 'Gewinne 10 Matches in QuizBall.' },
    icon: 'Users',
    target: 10,
  },
  {
    id: 'trophy_collector',
    title: { en: 'Trophy Collector', ka: 'თასების კოლექციონერი', ru: 'Коллекционер трофеев', pt: 'Colecionador de troféus', de: 'Trophäensammler' },
    description: { en: 'Win your first party quiz.', ka: 'მოიგე შენი პირველი ფართი ქვიზი.', ru: 'Выиграй свою первую командную викторину.', pt: 'Vença seu primeiro Party Quiz.', de: 'Gewinne dein erstes Party Quiz.' },
    icon: 'Award',
    target: 1,
  },
] as const;

export const ACHIEVEMENT_IDS = new Set(
  ACHIEVEMENT_DEFINITIONS.map((definition) => definition.id)
);
