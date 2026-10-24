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
  const { title, note } = locale === 'ru' ? withRussianText(list) : (OVERLAY_LOCALES as readonly string[]).includes(locale) ? withTranslatedText(list) : list;
  return { title: title[locale] ?? title.en, note: note ? note[locale] ?? note.en : null };
}

/** Tests only. */
export function forgetRussianText(): void {
  loaded = null;
  loading = null;
}

/** Languages whose list titles live in tenable_list_text (Russian keeps its own table, above). */
export const OVERLAY_LOCALES = ['pt', 'de'] as const;
type OverlayLocale = (typeof OVERLAY_LOCALES)[number];
let overlay: { at: number; byKey: Map<string, RussianText> } | null = null;
let overlayLoading: Promise<void> | null = null;

/** Reads tenable_list_text outside any caller's transaction; a failure keeps what was there. */
export function refreshOverlayText(): Promise<void> {
  overlayLoading ??= (async () => {
    try {
      const rows = await sql<Array<{ locale: string; list_id: string; src: string; title: string; note: string | null }>>`SELECT locale, list_id, src, title, note FROM tenable_list_text`;
      overlay = { at: Date.now(), byKey: new Map(rows.map((r) => [`${r.locale}:${r.list_id}:${r.src}`, { title: r.title, note: r.note }])) };
    } catch (error) {
      logger.warn({ err: error }, 'Tenable translated titles could not be read');
      overlay = { at: Date.now(), byKey: overlay?.byKey ?? new Map() };
    } finally {
      overlayLoading = null;
    }
  })();
  return overlayLoading;
}

/** Both title sources, refreshed together (startup and the readiness check). */
export function refreshTranslatedText(): Promise<void> {
  return Promise.all([refreshRussianText(), refreshOverlayText()]).then(() => undefined);
}

/** The list's title and note with every translated language in them: Russian (as withRussianText) plus the overlay languages. */
export function withTranslatedText<T extends Pick<TenableList, 'id' | 'title' | 'note'>>(list: T): Pick<TenableList, 'title' | 'note'> {
  if (!overlay || Date.now() - overlay.at > REFRESH_MS) void refreshOverlayText();
  let { title, note } = withRussianText(list);
  const src = russianTextSource(list);
  for (const locale of OVERLAY_LOCALES) {
    if (title[locale] && (!note || note[locale])) continue;
    const t = overlay?.byKey.get(`${locale}:${list.id}:${src}`);
    if (!t) continue;
    title = title[locale] ? title : { ...title, [locale]: t.title };
    note = !note || note[locale] || !t.note ? note : { ...note, [locale]: t.note };
  }
  return { title, note };
}

/** Tests only. */
export function forgetOverlayText(): void {
  overlay = null;
  overlayLoading = null;
}

export type { OverlayLocale };
