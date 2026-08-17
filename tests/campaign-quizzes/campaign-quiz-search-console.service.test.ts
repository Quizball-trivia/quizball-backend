import { describe, expect, it } from 'vitest';
import { campaignQuizSearchConsoleService } from '../../src/modules/campaign-quizzes/campaign-quiz-search-console.service.js';

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
});
