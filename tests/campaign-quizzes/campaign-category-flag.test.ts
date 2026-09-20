import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guards the CMS side of the campaign_only fix (backend #601/#602): the
// quiz-page manual-question flow is the only in-repo path that creates
// campaign categories, and it must brand new ones campaign_only so they can
// never enter the ranked draft — while a slug conflict with a pre-existing
// category (premier-league, liverpool, ... are real ranked categories that
// share campaign slugs) must leave that category's flag untouched.
// The upsert is inline SQL inside replaceManualQuestions, so we assert on the
// source text, in the spirit of tests/db/matchmaking-category-exclusions.test.ts.

const repoSource = readFileSync(
  fileURLToPath(
    new URL('../../src/modules/campaign-quizzes/campaign-quizzes.repo.ts', import.meta.url),
  ),
  'utf8',
);

function categoryUpsert(): string {
  const start = repoSource.indexOf('INSERT INTO categories');
  expect(start).toBeGreaterThan(-1);
  const end = repoSource.indexOf('`', start);
  return repoSource.slice(start, end);
}

describe('campaign category upsert', () => {
  it('creates new campaign categories with campaign_only = TRUE', () => {
    const upsert = categoryUpsert();
    expect(upsert).toMatch(/INSERT INTO categories \(slug, name, is_active, campaign_only\)/);
    expect(upsert).toMatch(/VALUES \(.*FALSE, TRUE\)/s);
  });

  it('never touches campaign_only on slug conflict with an existing category', () => {
    const upsert = categoryUpsert();
    const conflictStart = upsert.indexOf('ON CONFLICT');
    expect(conflictStart).toBeGreaterThan(-1);
    const conflictClause = upsert.slice(conflictStart);
    expect(conflictClause).not.toContain('campaign_only');
  });

  it('still creates new campaign categories inactive', () => {
    // First layer of defence from 2b1643db — campaign_only is the second.
    const upsert = categoryUpsert();
    expect(upsert).toMatch(/VALUES \(.*FALSE, TRUE\)/s);
  });
});
