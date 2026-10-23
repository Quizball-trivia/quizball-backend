import { describe, expect, it } from 'vitest';
import { pushCampaignSchema } from '../../src/modules/notifications/mobile-push.schemas.js';

const text = { en: 'New game', ka: 'ახალი თამაში', es: 'Nuevo juego', tr: 'Yeni oyun' };
const campaign = { campaignId: '6c6b8d10-8b8e-4d12-9a10-000000000101', title: text, body: text, route: '/(tabs)', confirmSend: true };

describe('push campaign text', () => {
  it('accepts optional Russian and Portuguese texts', () => {
    expect(pushCampaignSchema.safeParse(campaign).success).toBe(true);
    expect(pushCampaignSchema.safeParse({ ...campaign, title: { ...text, ru: 'Новая игра', pt: 'Jogo novo' }, body: { ...text, pt: 'Jogo novo' } }).success).toBe(true);
  });

  it('still requires the four original languages and rejects unknown ones', () => {
    expect(pushCampaignSchema.safeParse({ ...campaign, title: { en: 'New game', pt: 'Jogo novo' } }).success).toBe(false);
    expect(pushCampaignSchema.safeParse({ ...campaign, title: { ...text, fr: 'Nouveau jeu' } }).success).toBe(false);
  });
});
