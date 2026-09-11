import { describe, expect, it } from 'vitest';

// Mirrors the predicate in src/app.ts. Guards the 2026-09-09 incident:
// cms.quizball.io was added in Vercel and CMS login broke with CORS 403
// because the env allowlist only knew the old domains.
const FIRST_PARTY_ORIGIN = /^https:\/\/(?:[a-z0-9-]+\.)*quizball\.io$/;

describe('first-party CORS origin pattern', () => {
  it.each([
    'https://quizball.io',
    'https://cms.quizball.io',
    'https://staging-cms.quizball.io',
    'https://staging.quizball.io',
    'https://any-future-subdomain.quizball.io',
  ])('allows %s', (origin) => {
    expect(FIRST_PARTY_ORIGIN.test(origin)).toBe(true);
  });

  it.each([
    'http://cms.quizball.io',            // plain http never allowed
    'https://quizball.io.evil.com',      // suffix spoof
    'https://evilquizball.io',           // missing dot boundary
    'https://quizball.iox',
    'https://cms.quizball.io.attacker.net',
  ])('rejects %s', (origin) => {
    expect(FIRST_PARTY_ORIGIN.test(origin)).toBe(false);
  });
});
