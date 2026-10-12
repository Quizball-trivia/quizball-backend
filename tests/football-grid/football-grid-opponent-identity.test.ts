import { describe, expect, it } from 'vitest';
import { opponentIdentity } from '../../src/realtime/services/football-grid-realtime.service.js';
import { guestNameCandidates } from '../../src/modules/guest/guest-identity.js';

const bot = { userId: 'bot-1', isBot: true };
const botUser = { nickname: 'lukaberidze', avatar_url: 'https://img/bot.png', avatar_customization: { jersey: 'jersey_red' } };

describe('opponentIdentity', () => {
  it('shows a guest an anonymous guest-style bot with no roster identity or RP', () => {
    const shown = opponentIdentity({ opponent: bot, opponentUser: botUser, viewerUserId: 'guest-1', viewerIsGuest: true, rp: 1234 });
    expect(shown.username).toBe(guestNameCandidates('grid-bot:bot-1:guest-1', 1)[0]);
    expect(shown.username).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{4}$/);
    expect(shown.username).not.toBe('lukaberidze');
    expect(shown.avatarUrl).toBeNull();
    expect(shown).not.toHaveProperty('rp');
  });

  it('keeps one opponent for a guest across the games of a series, and a different one per bot and per guest', () => {
    const seen = (botId: string, guestId: string) => opponentIdentity({ opponent: { userId: botId, isBot: true }, opponentUser: botUser, viewerUserId: guestId, viewerIsGuest: true, rp: 1 });
    expect(seen('bot-1', 'guest-1')).toEqual(seen('bot-1', 'guest-1'));
    expect(seen('bot-2', 'guest-1').username).not.toBe(seen('bot-1', 'guest-1').username);
    expect(seen('bot-1', 'guest-2').username).not.toBe(seen('bot-1', 'guest-1').username);
  });

  it('keeps the real identity for members and for human opponents of guests', () => {
    expect(opponentIdentity({ opponent: bot, opponentUser: botUser, viewerUserId: 'member-1', viewerIsGuest: false, rp: 1234 }))
      .toEqual({ id: 'bot-1', username: 'lukaberidze', avatarUrl: 'https://img/bot.png', avatarCustomization: { jersey: 'jersey_red' }, rp: 1234 });
    const human = { userId: 'human-1', isBot: false };
    expect(opponentIdentity({ opponent: human, opponentUser: { ...botUser, nickname: 'Masked Keeper 4321' }, viewerUserId: 'guest-1', viewerIsGuest: true, rp: undefined }).username)
      .toBe('Masked Keeper 4321');
  });
});
