import type { L10n } from './football-race.rules.js';
import { RACE_RUSSIAN } from './football-race.ru.js';

/**
 * Russian wording for releases published without it, keyed by the English: nations, stats, eras, categories,
 * tournaments and the source line. A match line ("7–3 vs Paraguay · 1958") is rebuilt around the opponent's Russian
 * name; anything else not listed (a player's name) stays as written.
 */
const MATCH_LINE = /^(-?\d+–-?\d+) vs (.+) · (\d{4})$/;
const own = (table: Readonly<Record<string, string>>, key: string): string | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

export function russianText(en: string): string {
  const exact = own(RACE_RUSSIAN.text, en);
  if (exact) return exact;
  const line = MATCH_LINE.exec(en);
  const opponent = line && own(RACE_RUSSIAN.text, line[2]);
  return opponent ? `${line[1]} — ${opponent} · ${line[3]}` : en;
}

/** The label with its Russian attached when there is one (otherwise unchanged: a reader falls back to the English). */
export function withRussian<T extends L10n>(text: T): T {
  if (text.ru) return text;
  const ru = russianText(text.en);
  return ru === text.en ? text : { ...text, ru };
}

/** The stat's search words with the Russian ones added (Cyrillic never matches a Latin query, so every view can carry them). */
export function withRussianKeywords(label: L10n, keywords: string): string {
  const russian = own(RACE_RUSSIAN.keywords, label.en);
  return russian ? `${keywords} ${russian}` : keywords;
}
