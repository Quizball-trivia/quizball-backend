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

  it('maps localized Russian campaign URLs to the CMS slug', () => {
    const origin = 'https://quizball.io';

    expect(campaignQuizSlugFromPageUrl(
      'https://quizball.io/ru/futbolnaya-viktorina/ugaday-futbolista-po-karere',
      origin,
    )).toBe('career-path');
    expect(campaignQuizSlugFromPageUrl(
      'https://quizball.io/ru/futbolnaya-viktorina/viktorina-manchester-yunayted/',
      origin,
    )).toBe('manchester-united');
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/ru/football-quiz/arsenal', origin))
      .toBeNull();
  });

  it('maps localized Brazilian Portuguese campaign URLs to the CMS slug', () => {
    const origin = 'https://quizball.io';

    expect(campaignQuizSlugFromPageUrl('https://quizball.io/pt/quiz-de-futebol/adivinhe-o-jogador-pela-carreira', origin))
      .toBe('career-path');
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/pt/quiz-de-futebol/quiz-da-selecao-espanhola/', origin))
      .toBe('spain');
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/pt/football-quiz/arsenal', origin)).toBeNull();
  });

  it('ignores unrelated paths and foreign origins', () => {
    const origin = 'https://quizball.io';

    expect(campaignQuizSlugFromPageUrl('https://example.com/es/quiz-de-futbol/spain', origin))
      .toBeNull();
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/es/store', origin)).toBeNull();
  });
});
