import { describe, expect, it } from 'vitest';
import {
  normalizeCampaignQuizImageReference,
  publicCampaignQuizImageUrl,
} from '../../src/modules/campaign-quizzes/campaign-quiz-image-storage.service.js';

describe('campaign quiz image environment isolation', () => {
  it('stores an active-environment public URL as an object path', () => {
    expect(normalizeCampaignQuizImageReference(
      'https://test.supabase.co/storage/v1/object/public/imgs/categories/arsenal-cms-hero.webp',
    )).toBe('categories/arsenal-cms-hero.webp');
  });

  it('rejects a public Storage URL from another environment', () => {
    expect(() => normalizeCampaignQuizImageReference(
      'https://production-project.supabase.co/storage/v1/object/public/imgs/categories/arsenal.webp',
    )).toThrow(/different environment/);
  });

  it('rebases legacy absolute Storage URLs onto the active environment', () => {
    expect(publicCampaignQuizImageUrl(
      'https://production-project.supabase.co/storage/v1/object/public/imgs/categories/arsenal.webp',
    )).toBe(
      'https://test.supabase.co/storage/v1/object/public/imgs/categories/arsenal.webp',
    );
  });

  it('resolves new CMS upload paths against the active Supabase project', () => {
    expect(publicCampaignQuizImageUrl(
      'campaign-quizzes/arsenal-cms-hero.webp',
    )).toBe(
      'https://test.supabase.co/storage/v1/object/public/imgs/campaign-quizzes/arsenal-cms-hero.webp',
    );
  });

  it('rejects external image URLs in CMS writes', () => {
    expect(() => normalizeCampaignQuizImageReference(
      'https://example.com/arsenal.webp',
    )).toThrow(/uploaded through this CMS/);
  });
});
