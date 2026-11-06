#!/usr/bin/env npx tsx
/**
 * Georgian edition of the campaign quiz pages (/ka/football-quiz/…): the ka_* page columns of campaign_quizzes, in
 * Georgian script throughout. apply also sets locale_mode='en_ka' on pages whose copy and served questions are complete.
 * Modes and flags: scripts/campaign-quiz-edition.ts (count | cache | apply). Georgian searches are "ფეხბურთის ქვიზი",
 * "ქვიზი ფეხბურთზე" and "გამოიცანი ფეხბურთელი" (Google Suggest hl=ka, gl=GE, 2026-11-06).
 */
import { runEditionScript } from './campaign-quiz-edition.js';

const PAGE_SYSTEM = `You localize the SEO landing pages of QuizBall, a free football (soccer) quiz website, from English into Georgian for football fans in Georgia. Every key is "<page-slug>|<field>"; about_blocks.N keys are the paragraphs or bullet points of the page's "about" section.

SEO rules (most important):
- title, h1, breadcrumb_label and seo_title MUST begin with the exact lead given for the page (what Georgians type into Google). A quiz is "ქვიზი", never "ვიქტორინა".
- title and breadcrumb_label: the lead alone, or the lead plus a very short tail; at most 45 characters.
- h1: "<lead> — <short tail>" with the em dash when the English h1 has one (the page splits the heading at the dash), else the lead with an optional tail after a colon. At most 70 characters. Good tails: "შეამოწმე შენი ცოდნა", "რამდენად კარგად იცნობ?".
- seo_title: "<lead>: <tail> | QuizBall", at most 65 characters. Good tails: "ითამაშე უფასოდ", "შეამოწმე ცოდნა", "კითხვები და პასუხები". Never put a number of questions in the seo_title (no "10 კითხვა"), even when the English has one.
- meta_description: 120-160 characters, natural Georgian, uses the word "ქვიზი" and "უფასოდ" or "ონლაინ".

Language rules:
- Write EVERYTHING in Georgian script. Transliterate player, coach, club, stadium, country and competition names the way Georgian sports media do (Messi → მესი, Thierry Henry → ტიერი ანრი, Highbury → ჰაიბერი, Anfield → ენფილდი, Arsenal → არსენალი, Manchester United → მანჩესტერ იუნაიტედი, Germany → გერმანია, Spain → ესპანეთი, Premier League → პრემიერ ლიგა, La Liga → ლა ლიგა, Champions League → ჩემპიონთა ლიგა, World Cup → მსოფლიო ჩემპიონატი, Euro → ევროპის ჩემპიონატი, FA Cup → ინგლისის თასი, Ballon d'Or → ოქროს ბურთი). Never leave Latin letters, except the brand QuizBall, XP and abbreviations like AC, FC, PSG, VAR, UEFA, FIFA.
- Address the reader informally (შენ): ითამაშე, უპასუხე, შეამოწმე, შენი შედეგი.
- Glossary: ranked → რეიტინგული; ranked match → რეიტინგული მატჩი; ranked duel → რეიტინგული დუელი; Play Ranked → ითამაშე რეიტინგული; live duels → ცოცხალი დუელები; real fans → ნამდვილი გულშემატკივრები; leaderboard → ლიდერბორდი; coins → მონეტები; tickets → ბილეთები; hint or clue → მინიშნება; sign up → დარეგისტრირდი; badge or crest → ემბლემა; career path → კარიერის გზა; solo → სოლო. Never use betting words (ფსონი, ტოტალიზატორი).
- Georgian football terms: გუნდი, კლუბი, ნაკრები, მწვრთნელი, მეკარე, მცველი, ნახევარმცველი, თავდამსხმელი, ბომბარდირი, გულშემატკივარი, გოლი, პენალტი, სეზონი, ჩემპიონობა, თასი.
- Keep {count}, {score} and {total} placeholders exactly as written. {count} is 10 ("{count} კითხვა", "{count} გადამოწმებული კითხვა"; Georgian nouns stay singular after a number) outside the seo_title. "{score}/{total}" may stay as it is.
- Keep every fact exactly as stated; never add facts, names or answers that are not in the English. Keep numbers, years and seasons. Quotation marks „…“.
- Fan nicknames become a neutral phrase (არსენალის გულშემატკივრები) or their usual Georgian transliteration.
- Image alt texts stay plain descriptions. footer_button_label at most 30 characters.
- Neutral written register, no slang, no exclamation marks in titles. No explanations.

Return ONLY a JSON object mapping every input key to its Georgian text.`;

const ALLOWED_LATIN = /QuizBall|\{[a-z_]+\}|\b[A-Z]{2,5}\b/g;

await runEditionScript({
  locale: 'ka',
  language: 'Georgian',
  pageSystem: PAGE_SYSTEM,
  leads: {
    'career-path': 'გამოიცანი ფეხბურთელი კარიერით',
    'guess-the-player': 'გამოიცანი ფეხბურთელი',
    'club-badges': 'ფეხბურთის ემბლემების ქვიზი',
    'premier-league': 'პრემიერ ლიგის ქვიზი',
    'la-liga': 'ლა ლიგის ქვიზი',
    arsenal: 'არსენალის ქვიზი',
    'aston-villa': 'ასტონ ვილას ქვიზი',
    barcelona: 'ბარსელონას ქვიზი',
    bournemouth: 'ბორნმუთის ქვიზი',
    brentford: 'ბრენტფორდის ქვიზი',
    brighton: 'ბრაიტონის ქვიზი',
    chelsea: 'ჩელსის ქვიზი',
    'coventry-city': 'კოვენტრი სიტის ქვიზი',
    'crystal-palace': 'კრისტალ პალასის ქვიზი',
    everton: 'ევერტონის ქვიზი',
    fulham: 'ფულჰემის ქვიზი',
    'hull-city': 'ჰალ სიტის ქვიზი',
    'ipswich-town': 'იფსვიჩ თაუნის ქვიზი',
    'leeds-united': 'ლიდს იუნაიტედის ქვიზი',
    liverpool: 'ლივერპულის ქვიზი',
    'manchester-city': 'მანჩესტერ სიტის ქვიზი',
    'manchester-united': 'მანჩესტერ იუნაიტედის ქვიზი',
    'newcastle-united': 'ნიუკასლ იუნაიტედის ქვიზი',
    'nottingham-forest': 'ნოტინგემ ფორესტის ქვიზი',
    'real-madrid': 'რეალ მადრიდის ქვიზი',
    sunderland: 'სანდერლენდის ქვიზი',
    tottenham: 'ტოტენჰემის ქვიზი',
    argentina: 'არგენტინის ნაკრების ქვიზი',
    spain: 'ესპანეთის ნაკრების ქვიზი',
  },
  fixed: { 'Play Ranked': 'ითამაშე რეიტინგული' },
  questionCount: /\b\d+\s+(?:\p{L}+\s+)?კითხვ/u,
  textProblem: (text) => {
    const latin = text.replace(ALLOWED_LATIN, '').match(/[A-Za-z]+/g);
    return latin ? `Latin letters left: ${latin.slice(0, 3).join(' ')}` : null;
  },
  activateLocaleMode: true,
});
