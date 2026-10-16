import { russianPlural } from '../../core/i18n.js';
import type { FigureUnit, TenableLocale } from './tenable.content.js';

type CountedUnit = Exclude<FigureUnit, 'eur_m' | 'year' | 'none'>;

/** "141 goals" / "141 goles" / "141 gol" / "141 გოლი"; fees as "€222m" in every locale's own order. */
const WORDS: Record<CountedUnit, Record<Exclude<TenableLocale, 'ru'>, [string, string]>> = {
  goals: { en: ['goal', 'goals'], es: ['gol', 'goles'], tr: ['gol', 'gol'], ka: ['გოლი', 'გოლი'] },
  apps: { en: ['app', 'apps'], es: ['partido', 'partidos'], tr: ['maç', 'maç'], ka: ['მატჩი', 'მატჩი'] },
  caps: { en: ['cap', 'caps'], es: ['partido', 'partidos'], tr: ['maç', 'maç'], ka: ['მატჩი', 'მატჩი'] },
  titles: { en: ['title', 'titles'], es: ['título', 'títulos'], tr: ['kupa', 'kupa'], ka: ['ტიტული', 'ტიტული'] },
  assists: { en: ['assist', 'assists'], es: ['asistencia', 'asistencias'], tr: ['asist', 'asist'], ka: ['საგოლე პასი', 'საგოლე პასი'] },
  wins: { en: ['win', 'wins'], es: ['victoria', 'victorias'], tr: ['galibiyet', 'galibiyet'], ka: ['მოგება', 'მოგება'] },
  points: { en: ['pt', 'pts'], es: ['punto', 'puntos'], tr: ['puan', 'puan'], ka: ['ქულა', 'ქულა'] },
  seasons: { en: ['season', 'seasons'], es: ['temporada', 'temporadas'], tr: ['sezon', 'sezon'], ka: ['სეზონი', 'სეზონი'] },
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
  if (!format) formats.set(locale, (format = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : locale, { maximumFractionDigits: 1 })));
  return format.format(value);
};

export function formatFigure(figure: { value: number; unit: FigureUnit }, locale: TenableLocale): string {
  const { value, unit } = figure;
  if (unit === 'none') return '';
  if (unit === 'year') return String(Math.round(value));
  if (unit === 'eur_m') {
    const n = number(value, locale);
    return locale === 'es' ? `${n} M€` : locale === 'tr' ? `${n} milyon €` : locale === 'ka' ? `€${n} მლნ` : locale === 'ru' ? `${n} млн €` : `€${n}m`;
  }
  if (locale === 'ru') {
    const [one, few, many] = RUSSIAN[unit];
    return `${number(value, locale)} ${Number.isInteger(value) ? russianPlural(value, one, few, many) : few}`;
  }
  const [one, many] = WORDS[unit][locale];
  return `${number(value, locale)} ${value === 1 ? one : many}`;
}
