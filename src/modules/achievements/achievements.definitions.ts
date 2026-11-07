import type { AchievementDefinition } from './achievements.types.js';

export const ACHIEVEMENT_DEFINITIONS: readonly AchievementDefinition[] = [
  {
    id: 'debut_match',
    title: { en: 'Debut Match', es: 'Partido de debut', tr: 'İlk maç', ka: 'სადებიუტო მატჩი', ru: 'Дебютный матч', pt: 'Partida de estreia', de: 'Debüt-Match', fr: 'Premier match' },
    description: { en: 'Complete your first match.', es: 'Completa tu primer partido.', tr: 'İlk maçını tamamla.', ka: 'დაასრულე შენი პირველი მატჩი.', ru: 'Заверши свой первый матч.', pt: 'Complete sua primeira partida.', de: 'Schließe dein erstes Match ab.', fr: 'Termine ton premier match.' },
    icon: 'Trophy',
    target: 1,
  },
  {
    id: 'hat_trick_hero',
    title: { en: 'Hat-Trick Hero', es: 'Héroe del hat-trick', tr: 'Hat-trick kahramanı', ka: 'ჰეთ-ტრიკის გმირი', ru: 'Герой хет-трика', pt: 'Herói do hat-trick', de: 'Hattrick-Held', fr: 'Héros du triplé' },
    description: { en: 'Finish a match with every answer correct.', es: 'Termina un partido con todas las respuestas correctas.', tr: 'Bir maçı tüm cevapların doğru olacak şekilde bitir.', ka: 'დაასრულე მატჩი ყველა სწორი პასუხით.', ru: 'Закончи матч, ответив правильно на все вопросы.', pt: 'Termine uma partida acertando todas as respostas.', de: 'Beende ein Match mit allen richtigen Antworten.', fr: 'Termine un match avec toutes les bonnes réponses.' },
    icon: 'Star',
    target: 1,
  },
  {
    id: 'lightning_counter',
    title: { en: 'Lightning Counter', es: 'Contraataque relámpago', tr: 'Yıldırım kontra atağı', ka: 'ელვის სისწრაფე', ru: 'Молниеносный ответ', pt: 'Resposta relâmpago', de: 'Blitzantwort', fr: 'Réponse éclair' },
    description: { en: 'Answer a question correctly in under 2 seconds.', es: 'Responde correctamente una pregunta en menos de 2 segundos.', tr: 'Bir soruyu 2 saniyeden kısa sürede doğru cevapla.', ka: 'უპასუხე კითხვას სწორად 2 წამზე ნაკლებში.', ru: 'Правильно ответь на вопрос меньше чем за 2 секунды.', pt: 'Acerte uma pergunta em menos de 2 segundos.', de: 'Beantworte eine Frage in unter 2 Sekunden richtig.', fr: 'Réponds correctement à une question en moins de 2 secondes.' },
    icon: 'Zap',
    target: 1,
  },
  {
    id: 'clean_sheet',
    title: { en: 'Clean Sheet', es: 'Portería a cero', tr: 'Gol yemeden', ka: 'სუფთა ფურცელი', ru: 'Сухой матч', pt: 'Partida sem sofrer gols', de: 'Zu null', fr: 'Cage inviolée' },
    description: { en: 'Win a possession match without conceding a goal.', es: 'Gana un partido de posesión sin encajar ningún gol.', tr: 'Bir topa sahip olma maçını gol yemeden kazan.', ka: 'მოიგე ფლობის მატჩი გოლის მიღების გარეშე.', ru: 'Выиграй матч за владение мячом, не пропустив ни одного гола.', pt: 'Vença uma partida de posse de bola sem sofrer gols.', de: 'Gewinne ein Ballbesitz-Match, ohne ein Tor zu kassieren.', fr: 'Gagne un match de possession sans encaisser de but.' },
    icon: 'Trophy',
    target: 1,
  },
  {
    id: 'winning_streak',
    title: { en: 'Winning Streak', es: 'Racha de victorias', tr: 'Galibiyet serisi', ka: 'მოგების სერია', ru: 'Серия побед', pt: 'Sequência de vitórias', de: 'Siegesserie', fr: 'Série de victoires' },
    description: { en: 'Reach a 5-match win streak.', es: 'Consigue una racha de 5 victorias.', tr: '5 maçlık galibiyet serisi yap.', ka: 'მიაღწიე 5-მატჩიან მოგების სერიას.', ru: 'Выиграй 5 матчей подряд.', pt: 'Vença 5 partidas seguidas.', de: 'Erreiche eine Siegesserie von 5 Matches.', fr: 'Atteins une série de 5 victoires.' },
    icon: 'Flame',
    target: 5,
  },
  {
    id: 'multiplayer_master',
    title: { en: 'Multiplayer Master', es: 'Maestro multijugador', tr: 'Çok oyunculu ustası', ka: 'მრავალმოთამაშის ოსტატი', ru: 'Мастер мультиплеера', pt: 'Mestre do multiplayer', de: 'Multiplayer-Meister', fr: 'Maître du multijoueur' },
    description: { en: 'Win 10 matches in QuizBall.', es: 'Gana 10 partidos en QuizBall.', tr: 'QuizBall\'de 10 maç kazan.', ka: 'მოიგე 10 მატჩი QuizBall-ში.', ru: 'Выиграй 10 матчей в QuizBall.', pt: 'Vença 10 partidas no QuizBall.', de: 'Gewinne 10 Matches in QuizBall.', fr: 'Gagne 10 matchs sur QuizBall.' },
    icon: 'Users',
    target: 10,
  },
  {
    id: 'trophy_collector',
    title: { en: 'Trophy Collector', es: 'Coleccionista de trofeos', tr: 'Kupa koleksiyoncusu', ka: 'თასების კოლექციონერი', ru: 'Коллекционер трофеев', pt: 'Colecionador de troféus', de: 'Trophäensammler', fr: 'Collectionneur de trophées' },
    description: { en: 'Win your first party quiz.', es: 'Gana tu primer quiz en grupo.', tr: 'İlk parti quizini kazan.', ka: 'მოიგე შენი პირველი ფართი ქვიზი.', ru: 'Выиграй свою первую командную викторину.', pt: 'Vença seu primeiro Party Quiz.', de: 'Gewinne dein erstes Party Quiz.', fr: 'Gagne ton premier Party Quiz.' },
    icon: 'Award',
    target: 1,
  },
] as const;

export const ACHIEVEMENT_IDS = new Set(
  ACHIEVEMENT_DEFINITIONS.map((definition) => definition.id)
);
