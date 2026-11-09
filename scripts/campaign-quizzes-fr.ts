#!/usr/bin/env npx tsx
/**
 * French edition of the campaign quiz pages (/fr/quiz-foot/…): the fr_* page columns of campaign_quizzes. Modes and flags:
 * scripts/campaign-quiz-edition.ts (count | cache | apply). The leads come from the French SEO naming research (2026-11-06):
 * "quiz <club>", "quiz <pays> foot" for national teams (the country alone reads as geography), "quiz logo foot",
 * "devine le joueur", "devine le joueur avec les clubs".
 */
import { runEditionScript } from './campaign-quiz-edition.js';

const clubs: Record<string, string> = {
  arsenal: 'Arsenal', 'aston-villa': 'Aston Villa', bournemouth: 'Bournemouth', brentford: 'Brentford', brighton: 'Brighton', chelsea: 'Chelsea', 'coventry-city': 'Coventry City', 'crystal-palace': 'Crystal Palace', everton: 'Everton', fulham: 'Fulham', 'hull-city': 'Hull City', 'ipswich-town': 'Ipswich Town', 'leeds-united': 'Leeds United', liverpool: 'Liverpool', 'manchester-city': 'Manchester City', 'manchester-united': 'Manchester United', 'newcastle-united': 'Newcastle United', 'nottingham-forest': 'Nottingham Forest', 'real-madrid': 'Real Madrid', sunderland: 'Sunderland', tottenham: 'Tottenham',
};

const PAGE_SYSTEM = `You localize the SEO landing pages of QuizBall, a free football (soccer) quiz website, from English into standard French for football fans in France, Belgium, Switzerland, Canada and francophone Africa. Every key is "<page-slug>|<field>"; about_blocks.N keys are the paragraphs or bullet points of the page's "about" section.

SEO rules (most important):
- title, h1, breadcrumb_label and seo_title MUST begin with the exact lead given for the page (what French speakers type into Google), keeping its capitals.
- title and breadcrumb_label: the lead alone, or the lead plus a very short tail; at most 45 characters.
- h1: "<lead> — <short tail>" with the em dash when the English h1 has one (the page splits the heading at the dash), else the lead with an optional tail after " : ". At most 70 characters. Good tails: "Teste ta culture foot", "Connais-tu vraiment ce club ?". Write "foot" in every h1 ("Quiz Leeds United — Teste ta culture foot"): a bare city or club quiz reads as a pub quiz.
- seo_title: "<lead> : <tail> | QuizBall", at most 65 characters. Good tails: "Quiz football gratuit en ligne", "Teste ta culture foot". Never put a number of questions in the seo_title (no "10 questions"), even when the English has one.
- meta_description: 120-160 characters, natural French, uses the words "quiz" and "foot" or "football" once each and "gratuit" or "en ligne". Spell it "quiz", never "quizz".

Language rules:
- Address the reader informally as tu (Teste ta culture foot, Réponds aux questions, Ton score).
- Glossary: ranked → classé; ranked match → match classé; ranked duel → duel classé; Play Ranked → Jouer en classé; live duels → duels en direct; real fans → vrais supporters; leaderboard → classement; coins → pièces; tickets → tickets; hint or clue → indice; XP stays XP; sign up → inscris-toi; quiz stays quiz; QuizBall stays as written. Never use betting words (pari, parier, mise, cote, pronostic, cagnotte, jackpot, gains).
- Keep player, coach and stadium names exactly as written (Thierry Henry, Highbury, Anfield).
- Countries and national teams in French (Germany → Allemagne, Spain → Espagne, England → Angleterre, Argentina → Argentine, Netherlands → Pays-Bas, France → France, Italy → Italie, Brazil → Brésil, Portugal → Portugal, Wales → pays de Galles, Ivory Coast → Côte d'Ivoire).
- Competitions the way French media write them (World Cup → Coupe du monde, Euro → Euro, Champions League → Ligue des champions, Europa League → Ligue Europa, Conference League → Ligue Conférence, Copa América, Premier League, La Liga, Serie A, Bundesliga, Ligue 1 and FA Cup stay, Ballon d'Or stays, Golden Boot → Soulier d'or). Club names as written except the forms French media always use (Barcelona → FC Barcelone, Red Star Belgrade → Étoile rouge de Belgrade, Atlético Madrid → Atlético de Madrid, Sporting CP → Sporting Portugal, Seville → FC Séville, Naples → Naples, Rome → AS Rome).
- French football terms: équipe, club, sélection, entraîneur, sélectionneur, gardien, défenseur, milieu, attaquant, meilleur buteur, supporter, but (a goal scored, never "objectif"), penalty, saison, titre, coupe.
- Keep {count}, {score} and {total} placeholders exactly as written. {count} is 10 ("{count} questions", "{count} questions vérifiées") outside the seo_title. "{score}/{total}" may stay as it is.
- Keep every fact exactly as stated; never add facts, names or answers that are not in the English. Keep numbers, years and seasons; French number format for amounts (250 000 €, 1,5). Quotation marks « ».
- Fan nicknames may stay as written (Gunners, Reds) or become a neutral phrase (les supporters d'Arsenal).
- Image alt texts stay plain descriptions. footer_button_label at most 30 characters.
- Neutral written register, no slang, no exclamation marks in titles. No explanations.

Return ONLY a JSON object mapping every input key to its French text.`;

await runEditionScript({
  locale: 'fr',
  language: 'French',
  pageSystem: PAGE_SYSTEM,
  leads: {
    ...Object.fromEntries(Object.entries(clubs).map(([slug, club]) => [slug, `Quiz ${club}`])),
    barcelona: 'Quiz FC Barcelone',
    'career-path': 'Devine le joueur avec les clubs',
    'guess-the-player': 'Devine le joueur',
    'club-badges': 'Quiz logo foot',
    'premier-league': 'Quiz Premier League',
    'la-liga': 'Quiz La Liga',
    argentina: 'Quiz Argentine foot',
    spain: 'Quiz Espagne foot',
  },
  fixed: { 'Play Ranked': 'Jouer en classé' },
  questionCount: /\b\d+\s+(?:\p{L}+\s+)?questions?\b/iu,
  textProblem: (text) => (/(?:^|\s)(?:the|and|your|with|players)(?:\s|$)/i.test(text) ? 'English words left in the text' : null),
});
