/**
 * Copy of the outgoing player emails, one entry per language. Placeholders: {name}, {timeLeft}, {qp}, {n}.
 * Georgian and English readers of the Weekend League and daily reminder emails keep the owner-approved two-language
 * layout (Georgian first, English in grey): see `singleLanguageEmail`.
 */
export const EMAIL_LANGUAGES = ['en', 'ka', 'es', 'tr', 'ru', 'pt', 'de', 'fr'] as const;
export type EmailLanguage = (typeof EMAIL_LANGUAGES)[number];
export type JourneyMilestone = 3 | 7 | 14 | 30 | 60;
interface EmailBlock { subject: string; title: string; body: string; cta: string }
export interface EmailCopy {
  greetingNamed: string;
  greeting: string;
  unsubscribe: string;
  journey: Record<JourneyMilestone, EmailBlock>;
  comeback: EmailBlock;
  wl: { subject: string; title: string; bodyQualified: string; bodyNeeds: string; ctaEnter: string; ctaRanked: string; days: string; hours: string };
  daily: EmailBlock;
  wlEmailCta: string;
}

export const EMAIL_COPY: Record<EmailLanguage, EmailCopy> = {
  en: {
    greetingNamed: 'Hi {name}',
    greeting: 'Hi',
    unsubscribe: 'Unsubscribe',
    journey: {
      3: {
        subject: "Today's Quizball challenge is waiting",
        title: 'Up for one quick challenge?',
        body: "Come back for today's challenge and see how high you can score.",
        cta: 'Play Daily Challenge',
      },
      7: {
        subject: 'Weekend League is on Quizball',
        title: 'Your next competition is ready',
        body: 'Check the current Weekend League, play Ranked and earn the QP you need.',
        cta: 'View Weekend League',
      },
      14: {
        subject: 'Auction mode is now on Quizball',
        title: 'Try a new Auction match',
        body: 'Build your squad through the auction and compete with other players in a new mode.',
        cta: 'Play Auction',
      },
      30: {
        subject: 'A lot has changed in Quizball',
        title: "See what's waiting for you",
        body: 'Weekend League, Auction, Daily Challenge and new matches — choose a mode and play one game.',
        cta: 'Return to Quizball',
      },
      60: {
        subject: 'Ready for one match?',
        title: 'Quizball would love to have you back',
        body: 'Your account is ready. Come back, choose a mode and play one match.',
        cta: 'Play now',
      },
    },
    comeback: {
      subject: 'A new Quizball match is waiting',
      title: 'Come back to the game',
      body: 'It has been a while since your last match. Come back to Quizball and play one today.',
      cta: 'Play now',
    },
    wl: {
      subject: 'Weekend League closes in {timeLeft}',
      title: 'Weekend League is waiting',
      bodyQualified: 'You already have enough QP. Enter Weekend League before registration closes.',
      bodyNeeds: 'You only need {qp} more QP. Play Ranked and qualify before entry closes.',
      ctaEnter: 'Enter Weekend League',
      ctaRanked: 'Play Ranked',
      days: '{n}d',
      hours: '{n}h',
    },
    daily: {
      subject: 'Your Daily Challenge is ready',
      title: 'Your Daily Challenge is ready',
      body: 'Keep your streak alive with today’s challenge.',
      cta: 'Play now',
    },
    wlEmailCta: 'Play',
  },
  ka: {
    greetingNamed: 'გამარჯობა, {name}',
    greeting: 'გამარჯობა',
    unsubscribe: 'გამოწერის გაუქმება',
    journey: {
      3: {
        subject: 'დღევანდელი Quizball ჩელენჯი გელოდება',
        title: 'ერთი სწრაფი ჩელენჯი?',
        body: 'დაბრუნდი დღევანდელ ჩელენჯზე და შეამოწმე, რამდენ ქულას აიღებ.',
        cta: 'ითამაშე Daily Challenge',
      },
      7: {
        subject: 'უიქენდის ლიგა Quizball-ში',
        title: 'შენი შემდეგი შეჯიბრი მზადაა',
        body: 'ნახე უიქენდის ლიგის მიმდინარე სტატუსი, ითამაშე Ranked და დააგროვე საჭირო QP.',
        cta: 'ნახე Weekend League',
      },
      14: {
        subject: 'Auction რეჟიმი უკვე Quizball-შია',
        title: 'სცადე ახალი Auction მატჩი',
        body: 'ააწყვე შემადგენლობა აუქციონზე და შეეჯიბრე სხვა მოთამაშეებს ახალ რეჟიმში.',
        cta: 'ითამაშე Auction',
      },
      30: {
        subject: 'Quizball-ში ბევრი რამ შეიცვალა',
        title: 'ნახე, რა დაგხვდება დაბრუნებისას',
        body: 'Weekend League, Auction, Daily Challenge და ახალი მატჩები — აირჩიე რეჟიმი და დაიწყე ერთი თამაში.',
        cta: 'დაბრუნდი Quizball-ში',
      },
      60: {
        subject: 'ერთი მატჩისთვის მზად ხარ?',
        title: 'Quizball-ს შენი დაბრუნება უნდა',
        body: 'შენი ანგარიში ისევ მზადაა. შემოდი, აირჩიე სასურველი რეჟიმი და ითამაშე ერთი მატჩი.',
        cta: 'ითამაშე ახლა',
      },
    },
    comeback: {
      subject: 'Quizball-ში ახალი მატჩი გელოდება',
      title: 'დაბრუნდი თამაშში',
      body: 'ცოტა ხანია არ გითამაშია. დაბრუნდი Quizball-ში და ითამაშე ერთი მატჩი დღეს.',
      cta: 'ითამაშე ახლა',
    },
    wl: {
      subject: 'უიქენდის ლიგამდე {timeLeft} დარჩა',
      title: 'უიქენდის ლიგა გელოდება',
      bodyQualified: 'საკმარისი QP უკვე გაქვს. შედი უიქენდის ლიგაში, სანამ რეგისტრაცია დაიხურება.',
      bodyNeeds: 'შესასვლელად დაგრჩა მხოლოდ {qp} QP. ითამაშე Ranked და მოასწარი კვალიფიკაცია.',
      ctaEnter: 'შედი ლიგაში',
      ctaRanked: 'ითამაშე Ranked',
      days: '{n}d',
      hours: '{n}h',
    },
    daily: {
      subject: 'დღის გამოწვევა გელოდება',
      title: 'დღის გამოწვევა გელოდება',
      body: 'შეინარჩუნე სერია და ითამაშე დღევანდელი გამოწვევა.',
      cta: 'ითამაშე',
    },
    wlEmailCta: 'ითამაშე',
  },
  es: {
    greetingNamed: 'Hola {name}',
    greeting: 'Hola',
    unsubscribe: 'Cancelar suscripción',
    journey: {
      3: {
        subject: 'El desafío de hoy te espera en Quizball',
        title: '¿Te animas a un reto rápido?',
        body: 'Vuelve para jugar el desafío de hoy y descubre cuántos puntos puedes conseguir.',
        cta: 'Jugar al Desafío diario',
      },
      7: {
        subject: 'Weekend League está en Quizball',
        title: 'Tu próxima competición ya está lista',
        body: 'Consulta la Weekend League actual, juega en el modo Clasificatorio y consigue el QP que necesitas.',
        cta: 'Ver Weekend League',
      },
      14: {
        subject: 'El modo Subasta ya está en Quizball',
        title: 'Prueba una nueva partida de Subasta',
        body: 'Forma tu plantilla en la subasta y compite con otros jugadores en un modo nuevo.',
        cta: 'Jugar a Subasta',
      },
      30: {
        subject: 'Quizball ha cambiado mucho',
        title: 'Mira todo lo que te espera',
        body: 'Weekend League, Subasta, Desafío diario y nuevos partidos: elige un modo y juega un partido.',
        cta: 'Volver a Quizball',
      },
      60: {
        subject: '¿Te apetece jugar un partido?',
        title: 'Nos encantaría verte de vuelta en Quizball',
        body: 'Tu cuenta está lista. Vuelve, elige un modo y juega un partido.',
        cta: 'Jugar ahora',
      },
    },
    comeback: {
      subject: 'Te espera un nuevo partido en Quizball',
      title: 'Vuelve al juego',
      body: 'Hace tiempo que no juegas. Vuelve a Quizball y juega un partido hoy.',
      cta: 'Jugar ahora',
    },
    wl: {
      subject: 'La inscripción a la Weekend League cierra en {timeLeft}',
      title: 'La Weekend League te espera',
      bodyQualified: 'Ya tienes suficiente QP. Entra en Weekend League antes de que cierre la inscripción.',
      bodyNeeds: 'Solo te faltan {qp} QP. Juega en el modo Clasificatorio y clasifícate antes de que cierre la inscripción.',
      ctaEnter: 'Entrar en Weekend League',
      ctaRanked: 'Jugar a Clasificatorio',
      days: '{n} d',
      hours: '{n} h',
    },
    daily: {
      subject: 'Tu Desafío diario está listo',
      title: 'Tu Desafío diario está listo',
      body: 'Mantén tu racha con el desafío de hoy.',
      cta: 'Jugar ahora',
    },
    wlEmailCta: 'Jugar',
  },
  tr: {
    greetingNamed: 'Merhaba {name}',
    greeting: 'Merhaba',
    unsubscribe: 'Abonelikten çık',
    journey: {
      3: {
        subject: 'Bugünün Quizball meydan okuması seni bekliyor',
        title: 'Kısa bir meydan okumaya var mısın?',
        body: 'Bugünün meydan okuması için geri dön ve kaç puan alabileceğini gör.',
        cta: 'Günlük Meydan Okuma Oyna',
      },
      7: {
        subject: "Weekend League Quizball'da",
        title: 'Sıradaki rekabet seni bekliyor',
        body: "Mevcut Weekend League'e göz at, Sıralamalı oyna ve ihtiyacın olan QP'yi kazan.",
        cta: "Weekend League'i Gör",
      },
      14: {
        subject: "Açık Artırma modu artık Quizball'da",
        title: 'Yeni bir Açık Artırma maçı dene',
        body: 'Açık artırmada kadronu kur ve yeni bir modda diğer oyuncularla yarış.',
        cta: 'Açık Artırma Oyna',
      },
      30: {
        subject: "Quizball'da çok şey değişti",
        title: 'Seni nelerin beklediğine bak',
        body: 'Weekend League, Açık Artırma, Günlük Meydan Okuma ve yeni maçlar — bir mod seç ve bir maç oyna.',
        cta: "Quizball'a Dön",
      },
      60: {
        subject: 'Bir maça hazır mısın?',
        title: 'Quizball seni geri görmek ister',
        body: 'Hesabın hazır. Geri dön, bir mod seç ve bir maç oyna.',
        cta: 'Şimdi Oyna',
      },
    },
    comeback: {
      subject: 'Yeni bir Quizball maçı seni bekliyor',
      title: 'Oyuna geri dön',
      body: "Son maçının üzerinden biraz zaman geçti. Quizball'a dön ve bugün bir maç oyna.",
      cta: 'Şimdi Oyna',
    },
    wl: {
      subject: 'Weekend League {timeLeft} sonra kapanıyor',
      title: 'Weekend League seni bekliyor',
      bodyQualified: "Yeterince QP'n var. Kayıtlar kapanmadan Weekend League'e katıl.",
      bodyNeeds: 'Yalnızca {qp} QP daha kazanman gerekiyor. Sıralamalı oyna ve katılım kapanmadan elemelere katıl.',
      ctaEnter: "Weekend League'e Katıl",
      ctaRanked: 'Sıralamalı Oyna',
      days: '{n} gün',
      hours: '{n} saat',
    },
    daily: {
      subject: 'Günlük Meydan Okuma hazır',
      title: 'Günlük Meydan Okuma hazır',
      body: 'Bugünün meydan okumasıyla serini sürdür.',
      cta: 'Şimdi Oyna',
    },
    wlEmailCta: 'Oyna',
  },
  ru: {
    greetingNamed: 'Привет, {name}',
    greeting: 'Привет',
    unsubscribe: 'Отписаться',
    journey: {
      3: {
        subject: 'Сегодняшнее испытание Quizball уже ждёт',
        title: 'Сыграешь в короткое испытание?',
        body: 'Возвращайся на сегодняшнее испытание и проверь, сколько очков наберёшь.',
        cta: 'Играть в Ежедневное испытание',
      },
      7: {
        subject: 'Weekend League уже в Quizball',
        title: 'Тебя ждёт новое соревнование',
        body: 'Загляни в текущую Weekend League, сыграй в Рейтинговый матч и заработай нужные QP.',
        cta: 'Открыть Weekend League',
      },
      14: {
        subject: 'Режим «Аукцион» уже в Quizball',
        title: 'Попробуй новый матч в режиме «Аукцион»',
        body: 'Собери состав на аукционе и соревнуйся с другими игроками в новом режиме.',
        cta: 'Играть в Аукцион',
      },
      30: {
        subject: 'В Quizball многое изменилось',
        title: 'Посмотри, что тебя ждёт',
        body: 'Weekend League, Аукцион, Ежедневное испытание и новые матчи — выбери режим и сыграй.',
        cta: 'Вернуться в Quizball',
      },
      60: {
        subject: 'Сыграем матч?',
        title: 'Quizball будет рад твоему возвращению',
        body: 'Твой аккаунт готов. Возвращайся, выбери режим и сыграй матч.',
        cta: 'Играть сейчас',
      },
    },
    comeback: {
      subject: 'Тебя ждёт новый матч в Quizball',
      title: 'Возвращайся в игру',
      body: 'Последний матч был давно. Возвращайся в Quizball и сыграй сегодня.',
      cta: 'Играть сейчас',
    },
    wl: {
      subject: 'Weekend League закроется через {timeLeft}',
      title: 'Weekend League ждёт тебя',
      bodyQualified: 'У тебя уже достаточно QP. Вступай в Weekend League, пока регистрация не закрылась.',
      bodyNeeds: 'Тебе нужно заработать ещё {qp} QP. Играй в Рейтинговый матч и пройди отбор до закрытия регистрации.',
      ctaEnter: 'Войти в Weekend League',
      ctaRanked: 'Играть в Рейтинговый матч',
      days: '{n} дн.',
      hours: '{n} ч.',
    },
    daily: {
      subject: 'Ежедневное испытание уже готово',
      title: 'Ежедневное испытание уже готово',
      body: 'Сохрани серию, сыграв в сегодняшнее испытание.',
      cta: 'Играть сейчас',
    },
    wlEmailCta: 'Играть',
  },
  pt: {
    greetingNamed: 'Oi, {name}',
    greeting: 'Oi',
    unsubscribe: 'Cancelar inscrição',
    journey: {
      3: {
        subject: 'O desafio de hoje no Quizball está esperando',
        title: 'Que tal um desafio rápido?',
        body: 'Volte para o desafio de hoje e veja quantos pontos consegue fazer.',
        cta: 'Jogar Desafio diário',
      },
      7: {
        subject: 'Weekend League no Quizball',
        title: 'Sua próxima competição está pronta',
        body: 'Confira a Weekend League atual, jogue Ranqueada e ganhe o QP de que precisa.',
        cta: 'Ver Weekend League',
      },
      14: {
        subject: 'O modo Leilão chegou ao Quizball',
        title: 'Experimente uma nova partida de Leilão',
        body: 'Monte seu time no leilão e dispute com outros jogadores em um modo novo.',
        cta: 'Jogar Leilão',
      },
      30: {
        subject: 'Muita coisa mudou no Quizball',
        title: 'Veja o que está esperando por você',
        body: 'Weekend League, Leilão, Desafio diário e novas partidas — escolha um modo e jogue uma partida.',
        cta: 'Voltar ao Quizball',
      },
      60: {
        subject: 'Pronto para uma partida?',
        title: 'O Quizball adoraria ter você de volta',
        body: 'Sua conta está pronta. Volte, escolha um modo e jogue uma partida.',
        cta: 'Jogar agora',
      },
    },
    comeback: {
      subject: 'Uma nova partida espera por você no Quizball',
      title: 'Volte para o jogo',
      body: 'Faz um tempo desde sua última partida. Volte ao Quizball e jogue hoje.',
      cta: 'Jogar agora',
    },
    wl: {
      subject: 'As inscrições da Weekend League fecham em {timeLeft}',
      title: 'A Weekend League está esperando',
      bodyQualified: 'Você já tem QP suficiente. Entre na Weekend League antes que as inscrições terminem.',
      bodyNeeds: 'Faltam apenas {qp} QP. Jogue Ranqueada e se classifique antes que as inscrições terminem.',
      ctaEnter: 'Entrar na Weekend League',
      ctaRanked: 'Jogar Ranqueada',
      days: '{n} d',
      hours: '{n} h',
    },
    daily: {
      subject: 'Seu Desafio diário está pronto',
      title: 'Seu Desafio diário está pronto',
      body: 'Mantenha sua sequência com o desafio de hoje.',
      cta: 'Jogar agora',
    },
    wlEmailCta: 'Jogar',
  },
  de: {
    greetingNamed: 'Hi {name}',
    greeting: 'Hi',
    unsubscribe: 'Abmelden',
    journey: {
      3: {
        subject: 'Die heutige Quizball-Herausforderung wartet',
        title: 'Lust auf eine kurze Herausforderung?',
        body: 'Komm zurück zur heutigen Herausforderung und finde heraus, wie viele Punkte du holen kannst.',
        cta: 'Tages-Challenge spielen',
      },
      7: {
        subject: "Weekend League gibt's jetzt in Quizball",
        title: 'Dein nächster Wettbewerb ist bereit',
        body: 'Sieh dir die aktuelle Weekend League an, spiel Ranked und hol dir die QP, die du brauchst.',
        cta: 'Weekend League ansehen',
      },
      14: {
        subject: 'Der Modus Auktion ist jetzt in Quizball',
        title: 'Probier ein neues Auktion-Match aus',
        body: 'Stell dein Team bei der Auktion zusammen und tritt in einem neuen Modus gegen andere Spieler an.',
        cta: 'Auktion spielen',
      },
      30: {
        subject: 'In Quizball hat sich viel getan',
        title: 'Sieh, was auf dich wartet',
        body: 'Weekend League, Auktion, Tages-Challenge und neue Matches — wähl einen Modus und spiel eine Runde.',
        cta: 'Zurück zu Quizball',
      },
      60: {
        subject: 'Lust auf ein Match?',
        title: 'Quizball würde sich freuen, dich wiederzusehen',
        body: 'Dein Konto ist bereit. Komm zurück, wähl einen Modus und spiel ein Match.',
        cta: 'Jetzt spielen',
      },
    },
    comeback: {
      subject: 'Ein neues Quizball-Match wartet auf dich',
      title: 'Komm zurück ins Spiel',
      body: 'Dein letztes Match ist schon eine Weile her. Komm zurück zu Quizball und spiel heute eine Runde.',
      cta: 'Jetzt spielen',
    },
    wl: {
      subject: 'Anmeldung zur Weekend League endet in {timeLeft}',
      title: 'Die Weekend League wartet',
      bodyQualified: 'Du hast schon genug QP. Tritt der Weekend League bei, bevor die Anmeldung schließt.',
      bodyNeeds: 'Dir fehlen nur noch {qp} QP. Spiel Ranked und qualifizier dich, bevor die Anmeldung schließt.',
      ctaEnter: 'Weekend League beitreten',
      ctaRanked: 'Ranked spielen',
      days: '{n} Tg.',
      hours: '{n} Std.',
    },
    daily: {
      subject: 'Deine Tages-Challenge ist bereit',
      title: 'Deine Tages-Challenge ist bereit',
      body: 'Halte deine Serie mit der heutigen Challenge am Laufen.',
      cta: 'Jetzt spielen',
    },
    wlEmailCta: 'Spielen',
  },
  fr: {
    greetingNamed: 'Salut {name}',
    greeting: 'Salut',
    unsubscribe: 'Se désabonner',
    journey: {
      3: {
        subject: "Le défi Quizball du jour t’attend",
        title: 'Partant pour un petit défi ?',
        body: "Reviens pour le défi du jour et vois jusqu’où tu peux aller.",
        cta: 'Jouer au défi du jour',
      },
      7: {
        subject: 'La Weekend League est sur Quizball',
        title: 'Ta prochaine compétition est prête',
        body: "Regarde la Weekend League en cours, joue en classé et gagne les QP qu’il te faut.",
        cta: 'Voir la Weekend League',
      },
      14: {
        subject: 'Le mode Enchères foot arrive sur Quizball',
        title: 'Essaie un nouveau match Enchères foot',
        body: "Recrute ton équipe aux enchères et affronte d’autres joueurs dans un nouveau mode.",
        cta: 'Jouer aux Enchères foot',
      },
      30: {
        subject: 'Beaucoup de choses ont changé sur Quizball',
        title: "Découvre ce qui t’attend",
        body: 'Weekend League, Enchères foot, défi du jour et nouveaux matchs : choisis un mode et lance une partie.',
        cta: 'Revenir sur Quizball',
      },
      60: {
        subject: 'Partant pour un match ?',
        title: 'Quizball serait ravi de te revoir',
        body: 'Ton compte est prêt. Reviens, choisis un mode et joue un match.',
        cta: 'Jouer maintenant',
      },
    },
    comeback: {
      subject: "Un nouveau match Quizball t’attend",
      title: 'Reviens dans le jeu',
      body: "Ton dernier match remonte à un moment. Reviens sur Quizball et joues-en un aujourd’hui.",
      cta: 'Jouer maintenant',
    },
    wl: {
      subject: 'Les inscriptions à la Weekend League ferment dans {timeLeft}',
      title: "La Weekend League t’attend",
      bodyQualified: 'Tu as déjà assez de QP. Inscris-toi à la Weekend League avant la fin des inscriptions.',
      bodyNeeds: 'Il ne te manque que {qp} QP. Joue en classé et qualifie-toi avant la fin des inscriptions.',
      ctaEnter: 'Rejoindre la Weekend League',
      ctaRanked: 'Jouer en classé',
      days: '{n} j',
      hours: '{n} h',
    },
    daily: {
      subject: 'Ton défi du jour est prêt',
      title: 'Ton défi du jour est prêt',
      body: 'Garde ta série en vie avec le défi du jour.',
      cta: 'Jouer maintenant',
    },
    wlEmailCta: 'Jouer',
  },
};

export const fillCopy = (text: string, values: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));

/** A language that reads the email alone, in its own language. Georgian, English and unknown languages stay on the two-language layout. */
export function singleLanguageEmail(preferred: string | null | undefined): Exclude<EmailLanguage, 'en' | 'ka'> | null {
  const lang = preferred?.trim().toLowerCase().slice(0, 2);
  return lang === 'es' || lang === 'tr' || lang === 'ru' || lang === 'pt' || lang === 'de' || lang === 'fr' ? lang : null;
}
