import { describe, expect, it } from 'vitest';

import {
  campaignAttributionProperties,
  parseCampaignAttribution,
} from '../../src/core/campaign-attribution.js';

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('campaign attribution', () => {
  const now = Date.parse('2026-08-10T10:00:00.000Z');

  it('accepts a current, strictly shaped quiz conversion payload', () => {
    const parsed = parseCampaignAttribution(encode({
      source: 'campaign_quiz',
      quiz_slug: 'manchester-city',
      cta_placement: 'score',
      captured_at: '2026-08-10T09:59:00.000Z',
      anonymous_distinct_id: 'anon-123',
      auth_method: 'google',
      quiz_score: 12,
      quiz_total_questions: 15,
    }), now);

    expect(parsed).toMatchObject({
      quiz_slug: 'manchester-city',
      quiz_score: 12,
      quiz_total_questions: 15,
    });
    expect(campaignAttributionProperties(parsed!)).toMatchObject({
      source: 'campaign_quiz',
      quiz_type: 'campaign',
      quiz_slug: 'manchester-city',
      cta_placement: 'score',
      quiz_score_percent: 80,
    });
  });

  it.each([
    'not-base64',
    encode({ source: 'campaign_quiz' }),
    encode({
      source: 'campaign_quiz',
      quiz_slug: '../admin',
      cta_placement: 'score',
      captured_at: '2026-08-10T09:59:00.000Z',
      anonymous_distinct_id: 'anon-123',
    }),
    encode({
      source: 'campaign_quiz',
      quiz_slug: 'liverpool',
      cta_placement: 'score',
      captured_at: '2026-06-01T00:00:00.000Z',
      anonymous_distinct_id: 'anon-123',
    }),
    encode({
      source: 'campaign_quiz',
      quiz_slug: 'liverpool',
      cta_placement: 'score',
      captured_at: '2026-08-10T09:59:00.000Z',
      anonymous_distinct_id: 'anon-123',
      quiz_score: 16,
      quiz_total_questions: 15,
    }),
  ])('rejects malformed, unsafe, stale, or inconsistent payloads', (raw) => {
    expect(parseCampaignAttribution(raw, now)).toBeNull();
  });
});
