import { describe, expect, it } from 'vitest';
import {
  campaignQuizSearchConsoleService,
  campaignQuizSlugFromPageUrl,
} from '../../src/modules/campaign-quizzes/campaign-quiz-search-console.service.js';

describe('campaignQuizSearchConsoleService', () => {
  it('returns an explicit unconfigured state instead of fabricated metrics', async () => {
    await expect(campaignQuizSearchConsoleService.metrics()).resolves.toMatchObject({
      configured: false,
      reason: 'Search Console is not connected in this environment.',
      start_date: null,
      end_date: null,
      pages: [],
    });
  });

  it('maps English and localized Spanish campaign URLs to the CMS slug', () => {
    const origin = 'https://quizball.io';

    expect(campaignQuizSlugFromPageUrl(
      'https://quizball.io/en/football-quiz/real-madrid',
      origin,
    )).toBe('real-madrid');
    expect(campaignQuizSlugFromPageUrl(
      'https://quizball.io/es/quiz-de-futbol/seleccion-argentina',
      origin,
    )).toBe('argentina');
    expect(campaignQuizSlugFromPageUrl(
      'https://quizball.io/es/quiz-de-futbol/escudos-de-futbol/',
      origin,
    )).toBe('club-badges');
  });

  it('ignores unrelated paths and foreign origins', () => {
    const origin = 'https://quizball.io';

    expect(campaignQuizSlugFromPageUrl('https://example.com/es/quiz-de-futbol/spain', origin))
      .toBeNull();
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/es/store', origin)).toBeNull();
  });
});
