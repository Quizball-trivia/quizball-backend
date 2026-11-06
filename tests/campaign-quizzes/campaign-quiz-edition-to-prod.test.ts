import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decidePage } from '../../scripts/campaign-quiz-edition-to-prod.js';

const english = {
  title: 'Northwick Rovers Quiz', h1: 'Northwick Rovers Quiz', seo_title: 'Northwick Rovers Quiz | QuizBall', meta_description: 'Meta', breadcrumb_label: 'Northwick Rovers Quiz',
  lede: 'Lede', about_heading: 'About', hero_image_alt: 'Art', og_image_alt: null, score_cta: '{score}', footer_banner_text: 'Play', footer_button_label: 'Play Ranked',
  about_blocks: [{ id: 'a', type: 'paragraph', text: 'Body' }],
};
const copy = (locale: string) => ({
  ...Object.fromEntries(['title', 'h1', 'seo_title', 'meta_description', 'breadcrumb_label', 'lede', 'about_heading', 'hero_image_alt', 'score_cta', 'footer_banner_text', 'footer_button_label'].map((f) => [`${locale}_${f}`, `${locale} ${f}`])),
  [`${locale}_about_blocks`]: [{ id: 'a', type: 'paragraph', text: `${locale} body` }],
});
const question = (locale: string, filled = true) => ({
  id: '6c6b8d10-8b8e-4d12-9a10-000000000301', display_order: 1, difficulty: 'easy' as const,
  prompt: { en: 'Who?', ...(filled ? { [locale]: 'x' } : {}) }, explanation: null,
  payload: { type: 'mcq_single', options: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, text: { en: id, [locale]: id }, is_correct: i === 0 })) },
});
const decide = (locale: 'ka' | 'tr', target: Record<string, unknown>, source: Record<string, unknown> | undefined, filled = true) =>
  decidePage({ locale, activatesLocaleMode: locale === 'ka', target: { ...english, locale_mode: 'en_only', ...target }, source: source && { ...english, ...source }, questions: [question(locale, filled)] });

describe('copying a language edition to production', () => {
  it('writes complete copy onto an empty page whose English and questions match', () => {
    expect(decide('tr', {}, copy('tr'))).toEqual({ action: 'write' });
    expect(decide('ka', {}, copy('ka'))).toEqual({ action: 'write' });
  });

  it('leaves a page alone while its production questions are not all translated', () => {
    expect(decide('ka', {}, copy('ka'), false)).toEqual({ action: 'skip', reason: 'questions_incomplete' });
    expect(decide('tr', {}, copy('tr'), false)).toEqual({ action: 'skip', reason: 'questions_incomplete' });
  });

  it('leaves a page with nothing to play closed', () => {
    expect(decidePage({ locale: 'tr', activatesLocaleMode: false, target: { ...english }, source: { ...english, ...copy('tr') }, questions: [] }))
      .toEqual({ action: 'skip', reason: 'questions_incomplete' });
  });

  it('refuses when the English differs, naming the fields', () => {
    expect(decide('tr', { lede: 'Edited on production' }, copy('tr'))).toEqual({ action: 'skip', reason: 'english_differs', detail: ['lede'] });
  });

  it('refuses a missing or incomplete staging page', () => {
    expect(decide('tr', {}, undefined)).toEqual({ action: 'skip', reason: 'no_staging_page' });
    const { tr_lede: _lede, ...partial } = copy('tr') as Record<string, unknown>;
    expect(decide('tr', {}, partial)).toEqual({ action: 'skip', reason: 'staging_copy_incomplete', detail: ['lede'] });
  });

  it('sets en_ka only once copy and questions are complete, and only for Georgian', () => {
    expect(decide('ka', copy('ka'), copy('ka'))).toEqual({ action: 'activate' });
    expect(decide('ka', { ...copy('ka'), locale_mode: 'en_ka' }, copy('ka'))).toEqual({ action: 'nothing' });
    expect(decide('tr', copy('tr'), copy('tr'))).toEqual({ action: 'nothing' });
  });

  it('never overwrites production copy, and never opens on partial production copy', () => {
    const edited = { ...copy('tr'), tr_lede: 'Edited on production' };
    expect(decide('tr', edited, copy('tr'))).toEqual({ action: 'skip', reason: 'production_copy_differs', detail: ['tr_lede'] });
    expect(decide('ka', { ka_h1: 'only this' }, copy('ka'))).toMatchObject({ action: 'skip', reason: 'production_copy_incomplete' });
  });

  it('fills the empty fields when every existing value agrees with staging', () => {
    const source = copy('ka');
    const legacy = Object.fromEntries(['ka_h1', 'ka_lede', 'ka_seo_title', 'ka_meta_description'].map((column) => [column, source[column]]));
    expect(decide('ka', legacy, source)).toEqual({ action: 'write' });
    expect(decide('ka', { ...legacy, ka_about_blocks: [] }, source)).toEqual({ action: 'write' });
    expect(decide('ka', { ...legacy, ka_lede: 'Edited on production' }, source)).toMatchObject({ action: 'skip', reason: 'production_copy_incomplete' });
  });

  it('share-locks the assigned questions for the readiness check, in both write paths', () => {
    for (const file of ['campaign-quiz-edition-to-prod.ts', 'campaign-quiz-edition.ts']) {
      const script = readFileSync(fileURLToPath(new URL(`../../scripts/${file}`, import.meta.url)), 'utf8');
      expect(script).toContain('FOR SHARE OF cqq, q, qp');
    }
  });
});
