import { russianPlural } from '../../core/i18n.js';
import type { FigureUnit, TenableLocale } from './tenable.content.js';

type CountedUnit = Exclude<FigureUnit, 'eur_m' | 'year' | 'none'>;

/** "141 goals" / "141 goles" / "141 gols" / "141 gol" / "141 გოლი"; fees as "€222m" in every locale's own order. */
const WORDS: Record<CountedUnit, Record<Exclude<TenableLocale, 'ru'>, [string, string]>> = {
  goals: { en: ['goal', 'goals'], es: ['gol', 'goles'], pt: ['gol', 'gols'], de: ['Tor', 'Tore'], tr: ['gol', 'gol'], ka: ['გოლი', 'გოლი'] },
  apps: { en: ['app', 'apps'], es: ['partido', 'partidos'], pt: ['partida', 'partidas'], de: ['Spiel', 'Spiele'], tr: ['maç', 'maç'], ka: ['მატჩი', 'მატჩი'] },
  caps: { en: ['cap', 'caps'], es: ['partido', 'partidos'], pt: ['partida', 'partidas'], de: ['Länderspiel', 'Länderspiele'], tr: ['maç', 'maç'], ka: ['მატჩი', 'მატჩი'] },
  titles: { en: ['title', 'titles'], es: ['título', 'títulos'], pt: ['título', 'títulos'], de: ['Titel', 'Titel'], tr: ['kupa', 'kupa'], ka: ['ტიტული', 'ტიტული'] },
  assists: { en: ['assist', 'assists'], es: ['asistencia', 'asistencias'], pt: ['assistência', 'assistências'], de: ['Vorlage', 'Vorlagen'], tr: ['asist', 'asist'], ka: ['საგოლე პასი', 'საგოლე პასი'] },
  wins: { en: ['win', 'wins'], es: ['victoria', 'victorias'], pt: ['vitória', 'vitórias'], de: ['Sieg', 'Siege'], tr: ['galibiyet', 'galibiyet'], ka: ['მოგება', 'მოგება'] },
  points: { en: ['pt', 'pts'], es: ['punto', 'puntos'], pt: ['ponto', 'pontos'], de: ['Punkt', 'Punkte'], tr: ['puan', 'puan'], ka: ['ქულა', 'ქულა'] },
  seasons: { en: ['season', 'seasons'], es: ['temporada', 'temporadas'], pt: ['temporada', 'temporadas'], de: ['Saison', 'Saisons'], tr: ['sezon', 'sezon'], ka: ['სეზონი', 'სეზონი'] },
};

/** Russian counts take three forms (1 гол, 2 гола, 5 голов); a fraction takes the "few" form (2,5 гола). */
const RUSSIAN: Record<CountedUnit, [string, string, string]> = {
  goals: ['гол', 'гола', 'голов'],
  apps: ['матч', 'матча', 'матчей'],
  caps: ['матч', 'матча', 'матчей'],
  titles: ['титул', 'титула', 'титулов'],
  assists: ['ассист', 'ассиста', 'ассистов'],
  wins: ['победа', 'победы', 'побед'],
  points: ['очко', 'очка', 'очков'],
  seasons: ['сезон', 'сезона', 'сезонов'],
};

const formats = new Map<TenableLocale, Intl.NumberFormat>();
const number = (value: number, locale: TenableLocale) => {
  let format = formats.get(locale);
  if (!format) formats.set(locale, (format = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : locale === 'pt' ? 'pt-BR' : locale === 'de' ? 'de-DE' : locale, { maximumFractionDigits: 1 })));
  return format.format(value);
};

export function formatFigure(figure: { value: number; unit: FigureUnit }, locale: TenableLocale): string {
  const { value, unit } = figure;
  if (unit === 'none') return '';
  if (unit === 'year') return String(Math.round(value));
  if (unit === 'eur_m') {
    const n = number(value, locale);
    return locale === 'es' ? `${n} M€` : locale === 'pt' ? `€${n} mi` : locale === 'de' ? `${n} Mio. €` : locale === 'tr' ? `${n} milyon €` : locale === 'ka' ? `€${n} მლნ` : locale === 'ru' ? `${n} млн €` : `€${n}m`;
  }
  if (locale === 'ru') {
    const [one, few, many] = RUSSIAN[unit];
    return `${number(value, locale)} ${Number.isInteger(value) ? russianPlural(value, one, few, many) : few}`;
  }
  const [one, many] = WORDS[unit][locale];
  return `${number(value, locale)} ${value === 1 ? one : many}`;
}
