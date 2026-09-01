import { describe, expect, it } from 'vitest';
import { MATCHMAKING_CATEGORY_EXCLUSIONS } from '../../src/db/sql-fragments.js';

// Guards the fix for SEO campaign categories leaking into the ranked draft
// (2026-09-01: Coventry City appeared in ~950 ranked lobbies in 30 days).
// The fragment is the single source of truth — all seven matchmaking queries
// interpolate it — so asserting on it covers every draft path at once.

function fragmentSql(): string {
  // postgres.js fragments expose their assembled strings; join them so the
  // assertions read against the full predicate regardless of chunking.
  const parts = (MATCHMAKING_CATEGORY_EXCLUSIONS as unknown as { strings?: string[] }).strings;
  return Array.isArray(parts) ? parts.join(' ') : String(MATCHMAKING_CATEGORY_EXCLUSIONS);
}

describe('MATCHMAKING_CATEGORY_EXCLUSIONS', () => {
  it('excludes campaign-only categories from matchmaking', () => {
    expect(fragmentSql()).toContain('c.campaign_only = false');
  });

  it('still excludes the daily-challenge categories', () => {
    const sqlText = fragmentSql();
    expect(sqlText).toContain("c.slug NOT LIKE 'daily-challenges%'");
    for (const slug of ['career-path', 'imposter', 'countdown', 'high-low', 'money-drop']) {
      expect(sqlText).toContain(slug);
    }
  });

  it('does NOT exclude by campaign slug — real ranked categories share those slugs', () => {
    // premier-league / la-liga / barcelona / real-madrid all have SEO pages AND
    // are long-standing ranked categories with thousands of lobby appearances.
    // Excluding on slug membership in campaign_quizzes would silently remove
    // them from the draft.
    const sqlText = fragmentSql();
    for (const slug of ['premier-league', 'la-liga', 'barcelona', 'real-madrid', 'liverpool']) {
      expect(sqlText).not.toContain(slug);
    }
    expect(sqlText).not.toContain('campaign_quizzes');
  });
});
