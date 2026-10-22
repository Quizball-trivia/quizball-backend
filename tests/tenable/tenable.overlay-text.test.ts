import { describe, expect, it, vi } from 'vitest';

type Row = { locale?: string; list_id: string; src: string; title: string; note: string | null };
const db = vi.hoisted(() => ({ ru: [] as Row[], text: [] as Row[] }));
vi.mock('../../src/db/index.js', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => (strings.join('').includes('tenable_list_text') ? db.text : db.ru)),
}));

import type { TenableList } from '../../src/modules/tenable/tenable.content.js';
import {
  forgetOverlayText, forgetRussianText, refreshTranslatedText, russianTextSource, textIn, withTranslatedText,
} from '../../src/modules/tenable/tenable.text.js';

describe('Portuguese titles and notes (tenable_list_text)', () => {
  const list = { id: 'l-1', title: { en: 'Top scorers', es: 'x', ka: 'x', tr: 'x' }, note: { en: 'All competitions', es: 'x', ka: 'x', tr: 'x' } } as Pick<TenableList, 'id' | 'title' | 'note'>;

  it('come from the translation of the same English text; English stands in until then', async () => {
    forgetRussianText(); forgetOverlayText();
    db.ru = [];
    db.text = [{ locale: 'pt', list_id: 'l-1', src: russianTextSource(list), title: 'Maiores artilheiros', note: 'Todas as competições' }];
    expect(textIn(list, 'pt')).toEqual({ title: 'Top scorers', note: 'All competitions' });
    await refreshTranslatedText();
    expect(textIn(list, 'pt')).toEqual({ title: 'Maiores artilheiros', note: 'Todas as competições' });
    expect(withTranslatedText(list).title).toMatchObject({ en: 'Top scorers', pt: 'Maiores artilheiros' });
    expect(textIn(list, 'es').title).toBe('x');
  });

  it('a list corrected in English shows English, never the old translation', async () => {
    forgetRussianText(); forgetOverlayText();
    db.text = [{ locale: 'pt', list_id: 'l-1', src: russianTextSource(list), title: 'Maiores artilheiros', note: null }];
    await refreshTranslatedText();
    const corrected = { ...list, title: { ...list.title, en: 'Top scorers (league only)' } };
    expect(textIn(corrected, 'pt').title).toBe('Top scorers (league only)');
  });

  it('Russian and Portuguese fill side by side without touching each other', async () => {
    forgetRussianText(); forgetOverlayText();
    db.ru = [{ list_id: 'l-1', src: russianTextSource(list), title: 'Лучшие бомбардиры', note: null }];
    db.text = [{ locale: 'pt', list_id: 'l-1', src: russianTextSource(list), title: 'Maiores artilheiros', note: null }];
    await refreshTranslatedText();
    expect(withTranslatedText(list).title).toMatchObject({ ru: 'Лучшие бомбардиры', pt: 'Maiores artilheiros' });
    expect(textIn(list, 'ru').title).toBe('Лучшие бомбардиры');
    expect(textIn(list, 'pt').title).toBe('Maiores artilheiros');
  });
});
