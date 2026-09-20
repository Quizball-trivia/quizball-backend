import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

type SqlFragment = { text: string; values: unknown[] };
const dbMocks = vi.hoisted(() => {
  const taggedCalls: SqlFragment[] = [];
  const renderValue = (value: unknown): string =>
    value && typeof value === 'object' && 'text' in value ? (value as SqlFragment).text : '$param';
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((acc, part, index) => acc + part + (index < values.length ? renderValue(values[index]) : ''), '');
      const fragment = { text, values };
      if (/^\s*(SELECT|WITH)\b/i.test(text)) {
        taggedCalls.push(fragment);
        return Promise.resolve(text.includes('COUNT(*)') ? [{ total: '0' }] : []);
      }
      return fragment;
    }),
    { taggedCalls }
  );
  return { sql };
});
vi.mock('../../src/db/index.js', () => ({ sql: dbMocks.sql }));

const { categoriesRepo } = await import('../../src/modules/categories/categories.repo.js');

beforeEach(() => { dbMocks.sql.taggedCalls.length = 0; });

describe('categoriesRepo.list playable filter', () => {
  it('excludes SEO campaign-only categories when min_questions asks for playable ones', async () => {
    await categoriesRepo.list({ isActive: true, minQuestions: 5 }, 1, 50, 'en');
    const page = dbMocks.sql.taggedCalls.find((c) => c.text.includes('SELECT *'));
    expect(page?.text).toContain('campaign_only = false');
  });

  it('restricts to the requested slugs when given', async () => {
    await categoriesRepo.list({ isActive: true, minQuestions: 5, slugs: ['world-cup', 'premier-league'] }, 1, 50, 'en');
    const page = dbMocks.sql.taggedCalls.find((c) => c.text.includes('SELECT *'));
    expect(page?.text).toContain('slug = ANY(');
  });

  it('keeps campaign-only categories in the plain catalog listing', async () => {
    await categoriesRepo.list({ isActive: true }, 1, 50, 'en');
    const page = dbMocks.sql.taggedCalls.find((c) => c.text.includes('SELECT *'));
    expect(page?.text).not.toContain('campaign_only');
  });
});
