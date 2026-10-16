import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { russianTextSource, type TenableList, type TenableLocale } from './tenable.content.js';

export { russianTextSource };

const REFRESH_MS = 5 * 60_000;
type RussianText = { title: string; note: string | null };
let loaded: { at: number; byKey: Map<string, RussianText> } | null = null;
let loading: Promise<void> | null = null;


/** Reads tenable_list_ru (a few hundred rows) outside any caller's transaction; a failure keeps what was there. */
export function refreshRussianText(): Promise<void> {
  loading ??= (async () => {
    try {
      const rows = await sql<Array<{ list_id: string; src: string; title: string; note: string | null }>>`SELECT list_id, src, title, note FROM tenable_list_ru`;
      loaded = { at: Date.now(), byKey: new Map(rows.map((r) => [`${r.list_id}:${r.src}`, { title: r.title, note: r.note }])) };
    } catch (error) {
      logger.warn({ err: error }, 'Tenable Russian titles could not be read');
      // Tried again after the refresh interval, never on every view.
      loaded = { at: Date.now(), byKey: loaded?.byKey ?? new Map() };
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * The list's title and note with Russian in them (the list's own, else its translation), from memory only: callers may
 * hold a transaction or a match lock. A stale or cold cache refreshes in the background; until then English stands in.
 */
export function withRussianText<T extends Pick<TenableList, 'id' | 'title' | 'note'>>(list: T): Pick<TenableList, 'title' | 'note'> {
  if (!loaded || Date.now() - loaded.at > REFRESH_MS) void refreshRussianText();
  if (list.title.ru && (!list.note || list.note.ru)) return { title: list.title, note: list.note };
  const ru = loaded?.byKey.get(`${list.id}:${russianTextSource(list)}`);
  // Title and note each keep the list's own Russian; the translation fills only what is missing.
  return {
    title: list.title.ru || !ru ? list.title : { ...list.title, ru: ru.title },
    note: !list.note || list.note.ru || !ru?.note ? list.note : { ...list.note, ru: ru.note },
  };
}

/** One locale's title and note, English when that locale has none. */
export function textIn(list: Pick<TenableList, 'id' | 'title' | 'note'>, locale: TenableLocale): { title: string; note: string | null } {
  const { title, note } = locale === 'ru' ? withRussianText(list) : list;
  return { title: title[locale] ?? title.en, note: note ? note[locale] ?? note.en : null };
}

/** Tests only. */
export function forgetRussianText(): void {
  loaded = null;
  loading = null;
}
