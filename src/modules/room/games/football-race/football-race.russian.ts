import type { L10n } from './football-race.rules.js';
import { RACE_RUSSIAN } from './football-race.ru.js';
import { RACE_PORTUGUESE } from './football-race.pt.js';

/**
 * Wording for languages added after a release was published (Russian, Portuguese), keyed by the English: nations,
 * stats, eras, categories, tournaments and the source line. A match line ("7–3 vs Paraguay · 1958") is rebuilt around
 * the opponent's translated name; anything else not listed (a player's name) stays as written.
 */
const MATCH_LINE = /^(-?\d+–-?\d+) vs (.+) · (\d{4})$/;
const own = (table: Readonly<Record<string, string>>, key: string): string | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

type DictionaryLocale = 'ru' | 'pt';
const DICTIONARIES: Record<DictionaryLocale, { text: Readonly<Record<string, string>>; keywords: Readonly<Record<string, string>>; versus: string }> = {
  ru: { ...RACE_RUSSIAN, versus: '—' },
  pt: { ...RACE_PORTUGUESE, versus: 'x' },
};

export function dictionaryText(locale: DictionaryLocale, en: string): string {
  const { text, versus } = DICTIONARIES[locale];
  const exact = own(text, en);
  if (exact) return exact;
  const line = MATCH_LINE.exec(en);
  const opponent = line && own(text, line[2]);
  return opponent ? `${line[1]} ${versus} ${opponent} · ${line[3]}` : en;
}

export const russianText = (en: string): string => dictionaryText('ru', en);

/** The label with its dictionary languages attached where they have one (otherwise unchanged: a reader falls back to the English). */
export function withRussian<T extends L10n>(text: T): T {
  let out = text;
  for (const locale of Object.keys(DICTIONARIES) as DictionaryLocale[]) {
    if (out[locale]) continue;
    const translated = dictionaryText(locale, text.en);
    if (translated !== text.en) out = { ...out, [locale]: translated };
  }
  return out;
}

/** The stat's search words with the dictionary language's own added (Cyrillic never matches a Latin query, so every view can carry the Russian ones). */
export function withRussianKeywords(label: L10n, keywords: string, locale: DictionaryLocale = 'ru'): string {
  const extra = own(DICTIONARIES[locale].keywords, label.en);
  return extra ? `${keywords} ${extra}` : keywords;
}

export const isDictionaryLocale = (locale: string): locale is DictionaryLocale => Object.hasOwn(DICTIONARIES, locale);
