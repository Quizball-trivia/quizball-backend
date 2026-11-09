import { describe, expect, it } from 'vitest';
import { editionReady, missingPageTexts, pageProblem } from '../../scripts/campaign-quiz-edition.js';

const rules = {
  locale: 'tr' as const,
  leads: { 'northwick-rovers': 'Northwick Rovers Testi' },
  questionCount: /\b\d+\s+(?:\p{L}+\s+)?soru/iu,
  textProblem: (text: string) => (text.includes('the ') ? 'English words left in the text' : null),
};

describe('page copy checks', () => {
  it('accepts a title that starts with the lead, in any case the language folds to', () => {
    expect(pageProblem(rules, 'northwick-rovers|h1', 'Northwick Rovers Quiz', 'Northwick Rovers Testi — Bilgini Ölç')).toBeNull();
    expect(pageProblem(rules, 'northwick-rovers|h1', 'Northwick Rovers Quiz', 'NORTHWICK ROVERS TESTI')).toBe('does not start with "Northwick Rovers Testi"');
  });

  it('rejects a lost lead, a question count in the SEO title, a changed placeholder and empty text', () => {
    expect(pageProblem(rules, 'northwick-rovers|title', 'Northwick Rovers Quiz', 'Rovers bilgi yarışması')).toMatch(/does not start/);
    expect(pageProblem(rules, 'northwick-rovers|seo_title', 'Northwick Rovers Quiz: 10 Questions', 'Northwick Rovers Testi: 10 Soru')).toBe('question count in the seo_title');
    expect(pageProblem(rules, 'northwick-rovers|score_cta', 'You scored {score}/{total}', 'Puanın {score}')).toMatch(/^placeholders/);
    expect(pageProblem(rules, 'northwick-rovers|lede', 'Some text', '  ')).toBe('empty');
    expect(pageProblem(rules, 'northwick-rovers|lede', 'A longer English lede for the page', 'A longer English lede for the page')).toBe('left in English');
  });

  it('applies the language rule to body text', () => {
    expect(pageProblem(rules, 'northwick-rovers|lede', 'Some text', 'all the words')).toBe('English words left in the text');
  });

  it('counts every text a translation still lacks, against the English that exists', () => {
    const page = { title: 'T', h1: 'H', seo_title: 'S', meta_description: 'M', breadcrumb_label: 'B', lede: null, about_heading: null, hero_image_alt: null, og_image_alt: null, score_cta: null, footer_banner_text: null, footer_button_label: null, about_blocks: [{ id: 'a', type: 'paragraph' as const, text: 'x' }] };
    const full = { ...page, about_blocks: page.about_blocks };
    expect(missingPageTexts(page, full)).toBe(0);
    expect(missingPageTexts(page, null)).toBe(6);
    expect(missingPageTexts(page, { ...full, h1: null })).toBe(1);
    expect(missingPageTexts(page, { ...full, about_blocks: [] })).toBe(1);
    expect(missingPageTexts(page, { ...full, about_blocks: [{ id: 'a', type: 'paragraph', text: ' ' }] })).toBe(1);
  });

  it('switches a page on only by the service rule: blank body text, missing fields or open questions keep it off', () => {
    const page = { h1: 'H', seo_title: 'S', meta_description: 'M', about_blocks: [{ text: 'x' }], ka_h1: 'h', ka_seo_title: 's', ka_meta_description: 'm', ka_about_blocks: [{ text: 'y' }] };
    const options = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, text: { en: id, ka: id }, is_correct: i === 0 }));
    const question = { id: '6c6b8d10-8b8e-4d12-9a10-000000000401', display_order: 1, difficulty: 'easy' as const, prompt: { en: 'Who?', ka: 'x' }, explanation: null, payload: { type: 'mcq_single', options } };
    expect(editionReady(page, [question], 'ka')).toBe(true);
    expect(editionReady({ ...page, ka_about_blocks: [{ text: ' ' }] }, [question], 'ka')).toBe(false);
    expect(editionReady({ ...page, ka_about_blocks: JSON.stringify([{ text: 'y' }]) }, [question], 'ka')).toBe(false);
    expect(editionReady({ ...page, lede: 'L' }, [question], 'ka')).toBe(false);
    expect(editionReady(page, [{ ...question, prompt: { en: 'Who?' } }], 'ka')).toBe(false);
  });
});
