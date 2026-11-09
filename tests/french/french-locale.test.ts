import { describe, expect, it } from 'vitest';
import { RACE_FRENCH } from '../../src/modules/room/games/football-race/football-race.fr.js';
import { RACE_GERMAN } from '../../src/modules/room/games/football-race/football-race.de.js';
import { dictionaryText, isDictionaryLocale, withRussian, withRussianKeywords } from '../../src/modules/room/games/football-race/football-race.russian.js';
import { l10n } from '../../src/modules/room/games/football-race/football-race.rules.js';
import { EMAIL_COPY, singleLanguageEmail } from '../../src/modules/retention-email/email-copy.js';
import { finalReminder30mContent, qualifiedContent, wlEmailFor, wlLocalized } from '../../src/modules/weekend-league/wl-notifications.js';
import { formatFigure } from '../../src/modules/tenable/tenable.figures.js';
import { isNameLocale } from '../../src/modules/tenable/tenable.names.js';
import { OVERLAY_LOCALES } from '../../src/modules/tenable/tenable.text.js';
import { TENABLE_LOCALES } from '../../src/modules/tenable/tenable.content.js';
import { DAILY_CHALLENGE_DEFINITIONS } from '../../src/modules/daily-challenges/daily-challenges.definitions.js';
import { asRoomLocale } from '../../src/modules/room/room.types.js';
import { CAMPAIGN_QUIZ_LOCALES, FULL_COPY_LOCALES, hasEdition, QUESTION_GATED_LOCALES } from '../../src/modules/campaign-quizzes/campaign-quizzes.editions.js';
import { campaignQuizSlugFromPageUrl } from '../../src/modules/campaign-quizzes/campaign-quiz-search-console.service.js';
import { d501CategorySchema, textIn } from '../../src/modules/darts501/darts501.content.js';
import { category } from '../darts501/fixture.js';
import { CLUB_FR, ruleBased, validateEntry } from '../../scripts/football-grid-label-fr.js';

const L = (en: string) => ({ en, es: en, ka: en, tr: en });
/** The shipped copy uses French typography: curly apostrophes, no-break spaces before punctuation. */
const plain = (text: string | undefined) => text?.replace(/[\u00a0\u202f]/g, ' ').replace(/’/g, "'");
const BETTING = /\b(?:roulette|mise|miser|pari|parier|cote|pronostic|cagnotte|jackpot|casino)\b/i;

describe('French Horserace dictionary', () => {
  it('has exactly the labels and keywords of the German one', () => {
    expect(Object.keys(RACE_FRENCH.text).sort()).toEqual(Object.keys(RACE_GERMAN.text).sort());
    expect(Object.keys(RACE_FRENCH.keywords).sort()).toEqual(Object.keys(RACE_GERMAN.keywords).sort());
    expect(Object.keys(RACE_FRENCH.text)).toHaveLength(376);
    expect(Object.keys(RACE_FRENCH.keywords)).toHaveLength(69);
  });

  it('is wired in: nations, stats and match lines read French, with "contre"', () => {
    expect(isDictionaryLocale('fr')).toBe(true);
    expect(dictionaryText('fr', 'Germany')).toBe('Allemagne');
    expect(dictionaryText('fr', 'World Cup')).toBe('Coupe du monde');
    // The score and year are invented; a nation name is all the dictionary reads.
    expect(dictionaryText('fr', '9–8 vs Albania · 2031')).toBe('9–8 contre Albanie · 2031');
    expect(dictionaryText('fr', 'Invented Player · 2018')).toBe('Invented Player · 2018');
    expect(l10n({ en: 'Brazil', es: 'Brasil' }, 'fr')).toBe('Brésil');
    expect(withRussian(L('Most wins')).fr).toBe('Le plus de victoires');
    expect(withRussianKeywords(L('Most wins'), 'won', 'fr')).toMatch(/^won .*victoires/);
  });

  it('uses French wording and no betting words', () => {
    for (const value of [...Object.values(RACE_FRENCH.text), ...Object.values(RACE_FRENCH.keywords)]) expect(value).not.toMatch(BETTING);
    expect(plain(RACE_FRENCH.text['Most individual awards (Golden Ball, Boot, Glove…)'])).toContain("Soulier d'or");
    expect(RACE_FRENCH.text.Spain).toBe('Espagne');
  });
});

describe('French server copy', () => {
  it('reads the email alone in French, and leaves Georgian and English on the two-language layout', () => {
    expect(singleLanguageEmail('fr')).toBe('fr');
    expect(singleLanguageEmail('FR-be')).toBe('fr');
    expect(singleLanguageEmail('ka')).toBeNull();
    expect(singleLanguageEmail('en')).toBeNull();
    expect(EMAIL_COPY.fr.unsubscribe).toBe('Se désabonner');
    const email = wlEmailFor(qualifiedContent(Date.parse('2026-10-11T18:00:00Z'), 600_000), 'fr');
    expect(plain(email.subject)).toContain('Tu es en finale');
    expect(email.html).toContain(EMAIL_COPY.fr.wlEmailCta);
    expect(email.html).not.toContain('ითამაშე');
  });

  it('gives the Weekend League final window with French days and clock', () => {
    const final = qualifiedContent(Date.parse('2026-10-11T18:00:00Z'), 600_000);
    expect(plain(final.titleFr)).toBe('Tu es en finale ! Refais le check-in dimanche de 21h50 à 22h00, heure de Géorgie');
    expect(plain(final.bodyFr)).toContain('La finale commence dimanche à 22h00');
    expect(plain(final.bodyFr)).toContain('entre 21h50 et 22h00');
    const overMidnight = qualifiedContent(Date.parse('2026-10-11T20:05:00Z'), 600_000);
    expect(plain(overMidnight.titleFr)).toContain('dimanche à 23h55 – lundi à 00h05');
    expect(plain(finalReminder30mContent(Date.parse('2026-10-11T18:00:00Z'), 600_000).titleFr)).toBe('La finale commence à 22h00, heure de Géorgie !');
    expect(wlLocalized(final).title.fr).toBe(final.titleFr);
    expect(JSON.stringify(qualifiedContent(Number.NaN, 600_000).titleFr)).not.toMatch(/\d/);
  });

  it('names the daily challenges as the French SEO table does', () => {
    const titles = Object.fromEntries(Object.entries(DAILY_CHALLENGE_DEFINITIONS).map(([key, value]) => [key, plain(value.title.fr)]));
    expect(titles).toMatchObject({
      moneyDrop: 'Répartis tes pièces', trueFalse: 'Vrai ou faux', clues: 'Qui suis-je ?', countdown: 'Cite le plus de joueurs',
      putInOrder: 'Frise du foot', imposter: "Trouve l'intrus", careerPath: 'Parcours du joueur', highLow: 'Higher or Lower',
      footballLogic: 'Rébus foot', missingXi: 'Devine le 11', passChain: 'Relie les joueurs', statSniper: 'Au plus proche',
      cardDetective: 'Devine la carte',
    });
    for (const value of Object.values(DAILY_CHALLENGE_DEFINITIONS)) {
      expect(value.title.fr).toBeTruthy();
      expect(value.description.fr).not.toMatch(BETTING);
    }
  });

  it('asks the Imposter daily to pick the right answers, whatever its name says', () => {
    expect(DAILY_CHALLENGE_DEFINITIONS.imposter.description.fr).toContain('toutes les bonnes réponses');
  });
});

describe('French Darts 501', () => {
  const filler = Array.from({ length: 40 }, (_, i) => ({ eid: `p${i}`, value: i + 1 }));

  it('keeps every stored category valid: French is optional and falls back to English', () => {
    const stored = { ...category(), entries: filler };
    expect(d501CategorySchema.safeParse(stored).success).toBe(true);
    expect(textIn(stored, 'fr').title).toBe(stored.title.en);
    const french = { ...stored, title: { ...stored.title, fr: 'Titre inventé' } };
    expect(d501CategorySchema.safeParse(french).success).toBe(true);
    expect(textIn(french, 'fr').title).toBe('Titre inventé');
  });
});

describe('French Tenable', () => {
  it('formats figures in French', () => {
    expect(formatFigure({ value: 1, unit: 'goals' }, 'fr')).toBe('1 but');
    expect(formatFigure({ value: 2, unit: 'goals' }, 'fr')).toBe('2 buts');
    expect(formatFigure({ value: 3, unit: 'caps' }, 'fr')).toBe('3 sélections');
    expect(formatFigure({ value: 1, unit: 'assists' }, 'fr')).toBe('1 passe décisive');
    expect(formatFigure({ value: 45.5, unit: 'eur_m' }, 'fr')).toBe('45,5 M€');
    expect(formatFigure({ value: 1999, unit: 'year' }, 'fr')).toBe('1999');
  });

  it('accepts French everywhere Portuguese and German are', () => {
    expect(TENABLE_LOCALES).toContain('fr');
    expect(OVERLAY_LOCALES).toContain('fr');
    expect(isNameLocale('fr')).toBe(true);
    expect(asRoomLocale('fr')).toBe('fr');
  });
});

describe('French campaign quiz edition', () => {
  const copy = {
    fr_title: 't', fr_h1: 'h', fr_seo_title: 's', fr_meta_description: 'm', fr_breadcrumb_label: 'b', fr_lede: 'l', fr_about_heading: 'a',
    fr_about_blocks: [{ text: 'x' }], fr_hero_image_alt: 'i', fr_og_image_alt: 'o', fr_score_cta: 'c', fr_footer_banner_text: 'f', fr_footer_button_label: 'g',
  };
  const english = {
    locale_mode: 'en_only' as const, title: 'T', h1: 'H', seo_title: 'S', meta_description: 'M', breadcrumb_label: 'B', lede: 'L', about_heading: 'A',
    about_blocks: [{ text: 'X' }], hero_image_alt: 'I', og_image_alt: 'O', score_cta: 'C', footer_banner_text: 'F', footer_button_label: 'G',
  };

  it('is a full-copy, question-gated edition like Georgian and Turkish', () => {
    expect(CAMPAIGN_QUIZ_LOCALES).toContain('fr');
    expect(QUESTION_GATED_LOCALES.has('fr')).toBe(true);
    expect(FULL_COPY_LOCALES).toContain('fr');
    expect(hasEdition({ ...english, ...copy }, 'fr')).toBe(true);
    expect(hasEdition({ ...english, ...copy, fr_lede: null }, 'fr')).toBe(false);
    expect(hasEdition(english, 'fr')).toBe(false);
  });

  it('maps French campaign URLs to the CMS slug', () => {
    const origin = 'https://quizball.io';
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/fr/quiz-foot/devine-le-joueur-avec-les-clubs', origin)).toBe('career-path');
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/fr/quiz-foot/quiz-fc-barcelone/', origin)).toBe('barcelona');
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/fr/quiz-foot/quiz-espagne-foot', origin)).toBe('spain');
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/fr/football-quiz/arsenal', origin)).toBeNull();
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/fr/jeux-de-foot/quiz-arsenal', origin)).toBeNull();
  });
});

describe('French grid labels', () => {
  it('builds teammate, manager and club labels by rule, names verbatim', () => {
    expect(ruleBased('teammate', 'Club teammate of Ada Quill')).toBe('A joué en club avec Ada Quill');
    expect(ruleBased('teammate', 'Played with Ada Quill')).toBe('A joué avec Ada Quill');
    expect(ruleBased('manager', 'Ada Quill')).toBe('Ada Quill');
    expect(ruleBased('club', 'Northwick Rovers')).toBe('Northwick Rovers');
    expect(ruleBased('club', 'Red Star Belgrade')).toBe(CLUB_FR['Red Star Belgrade']);
  });

  it('holds trophies and countries to the expected forms', () => {
    const entry = (family: 'trophy_award' | 'country', en: string, fr: string) => ({ en, family, fr });
    expect(validateEntry('trophy:uefa-champions-league', entry('trophy_award', 'UEFA Champions League winner', 'Vainqueur de la Ligue des champions')).errors).toEqual([]);
    expect(validateEntry('trophy:la-liga-title', entry('trophy_award', 'La Liga winner', 'Vainqueur de La Liga')).errors).toEqual([]);
    expect(validateEntry('trophy:uefa-champions-league', entry('trophy_award', 'UEFA Champions League winner', 'Champions League')).errors).not.toEqual([]);
    expect(validateEntry('country:germany', entry('country', 'Germany', 'Allemagne')).errors).toEqual([]);
    expect(validateEntry('country:germany', entry('country', 'Germany', 'Germanie')).errors).not.toEqual([]);
  });
});
