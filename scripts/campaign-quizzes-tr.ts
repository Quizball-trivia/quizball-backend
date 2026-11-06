#!/usr/bin/env npx tsx
/**
 * Turkish edition of the campaign quiz pages (/tr/futbol-bilgi-yarismasi/…): the tr_* page columns of campaign_quizzes.
 * Modes and flags: scripts/campaign-quiz-edition.ts (count | cache | apply). The leads are what Google Suggest shows for
 * hl=tr, gl=TR (2026-11-06): "testi" for clubs ("real madrid testi", "chelsea testi", "galatasaray testi çöz"),
 * "premier lig quiz", "la liga quiz", "futbolcu bilmece", "kariyerden futbolcu tahmin etme", "logodan takım bilme".
 */
import { runEditionScript } from './campaign-quiz-edition.js';

const clubs: Record<string, string> = {
  arsenal: 'Arsenal', 'aston-villa': 'Aston Villa', barcelona: 'Barcelona', bournemouth: 'Bournemouth', brentford: 'Brentford',
  brighton: 'Brighton', chelsea: 'Chelsea', 'coventry-city': 'Coventry City', 'crystal-palace': 'Crystal Palace', everton: 'Everton',
  fulham: 'Fulham', 'hull-city': 'Hull City', 'ipswich-town': 'Ipswich Town', 'leeds-united': 'Leeds United', liverpool: 'Liverpool',
  'manchester-city': 'Manchester City', 'manchester-united': 'Manchester United', 'newcastle-united': 'Newcastle United',
  'nottingham-forest': 'Nottingham Forest', 'real-madrid': 'Real Madrid', sunderland: 'Sunderland', tottenham: 'Tottenham',
};

const PAGE_SYSTEM = `You localize the SEO landing pages of QuizBall, a free football (soccer) quiz website, from English into Turkish for football fans in Turkey. Every key is "<page-slug>|<field>"; about_blocks.N keys are the paragraphs or bullet points of the page's "about" section.

SEO rules (most important):
- title, h1, breadcrumb_label and seo_title MUST begin with the exact lead given for the page (what Turkish speakers type into Google), keeping its Turkish title case.
- title and breadcrumb_label: the lead alone, or the lead plus a very short tail; at most 45 characters.
- h1: "<lead> — <short tail>" with the em dash when the English h1 has one (the page splits the heading at the dash), else the lead with an optional tail after a colon. At most 70 characters. Good tails: "Bilgini Ölç", "Ne Kadar Biliyorsun?".
- seo_title: "<lead>: <tail> | QuizBall", at most 65 characters. Good tails: "Soruları Çöz, Bilgini Ölç", "Ücretsiz Online Oyna", "Sorular ve Cevaplar". Never put a number of questions in the seo_title (no "10 Soru"), even when the English has one.
- meta_description: 120-160 characters, natural Turkish, uses the words "bilgi yarışması" or "testi" and "ücretsiz" or "online".

Language rules:
- Address the reader informally as sen (Bilgini ölç, Soruları çöz, Puanın).
- Glossary: ranked → sıralamalı; ranked match → sıralamalı maç; ranked duel → sıralamalı düello; Play Ranked → Sıralamalı Oyna; live duels → canlı düellolar; real fans → gerçek taraftarlar; leaderboard → sıralama; coins → jeton; tickets → bilet; hint or clue → ipucu; XP stays XP; sign up → kayıt ol; quiz → "test" or "bilgi yarışması" in running text; QuizBall stays as written, with an apostrophe before suffixes (QuizBall'da). Never use betting words (bahis, iddaa, kupon).
- Keep player, coach and stadium names in Latin letters exactly as written (Thierry Henry, Highbury, Anfield), with an apostrophe before Turkish suffixes (Henry'nin, Anfield'da).
- Countries and national teams in Turkish (Germany → Almanya, Spain → İspanya, England → İngiltere, Argentina → Arjantin, Netherlands → Hollanda, France → Fransa, Italy → İtalya, Brazil → Brezilya, Portugal → Portekiz, Ivory Coast → Fildişi Sahili).
- Competitions the way Turkish media write them (World Cup → Dünya Kupası, Euro → Avrupa Şampiyonası, Champions League → Şampiyonlar Ligi, Europa League → Avrupa Ligi, Premier League → Premier Lig, FA Cup → FA Cup, La Liga stays, Ballon d'Or stays, Golden Boot → Altın Ayakkabı). Club names as written except the forms Turkish media always use (Bayern Munich → Bayern Münih, Inter Milan → Inter, AC Milan → Milan).
- Turkish football terms: takım, kulüp, milli takım, teknik direktör, kaleci, stoper, orta saha, forvet, gol kralı, taraftar, gol, penaltı, sezon, şampiyonluk, kupa.
- Keep {count}, {score} and {total} placeholders exactly as written. {count} is 10 ("{count} soru", "{count} doğrulanmış soru") outside the seo_title. "{score}/{total}" may stay as it is.
- Keep every fact exactly as stated; never add facts, names or answers that are not in the English. Keep numbers, years and seasons; Turkish number format for amounts (€250.000, 1,5). Quotation marks “…”.
- Fan nicknames may stay as written (Gunners, Reds) or become a neutral phrase (Arsenal taraftarları).
- Image alt texts stay plain descriptions. footer_button_label at most 30 characters.
- Neutral written register, no slang, no exclamation marks in titles. No explanations.

Return ONLY a JSON object mapping every input key to its Turkish text.`;

await runEditionScript({
  locale: 'tr',
  language: 'Turkish',
  pageSystem: PAGE_SYSTEM,
  leads: {
    ...Object.fromEntries(Object.entries(clubs).map(([slug, club]) => [slug, `${club} Testi`])),
    'career-path': 'Kariyerden Futbolcu Tahmin Etme',
    'guess-the-player': 'Futbolcu Bilmece',
    'club-badges': 'Logodan Takım Bilme',
    'premier-league': 'Premier Lig Quiz',
    'la-liga': 'La Liga Quiz',
    argentina: 'Arjantin Milli Takımı Testi',
    spain: 'İspanya Milli Takımı Testi',
  },
  fixed: { 'Play Ranked': 'Sıralamalı Oyna' },
  questionCount: /\b\d+\s+(?:\p{L}+\s+)?(?:soru|sorular)/iu,
  textProblem: (text) => (/(?:^|\s)(?:the|and|your|with|questions)(?:\s|$)/i.test(text) ? 'English words left in the text' : null),
});
