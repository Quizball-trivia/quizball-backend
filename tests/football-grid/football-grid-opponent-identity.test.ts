import { describe, expect, it } from 'vitest';
import { opponentIdentity } from '../../src/realtime/services/football-grid-realtime.service.js';
import { guestNameCandidates } from '../../src/modules/guest/guest-identity.js';

const bot = { userId: 'bot-1', isBot: true };
const botUser = { nickname: 'lukaberidze', avatar_url: 'https://img/bot.png', avatar_customization: { jersey: 'jersey_red' } };

describe('opponentIdentity', () => {
  it('shows a guest an anonymous guest-style bot, stable per match, with no roster identity or RP', () => {
    const shown = opponentIdentity({ opponent: bot, opponentUser: botUser, matchId: 'm-1', viewerIsGuest: true, rp: 1234 });
    expect(shown.username).toBe(guestNameCandidates('grid-bot:m-1', 1)[0]);
    expect(shown.username).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{4}$/);
    expect(shown.username).not.toBe('lukaberidze');
    expect(shown.avatarUrl).toBeNull();
    expect(shown).not.toHaveProperty('rp');
    expect(opponentIdentity({ opponent: bot, opponentUser: botUser, matchId: 'm-1', viewerIsGuest: true, rp: 1 }).username).toBe(shown.username);
    expect(opponentIdentity({ opponent: bot, opponentUser: botUser, matchId: 'm-2', viewerIsGuest: true, rp: 1 }).username).not.toBe(shown.username);
  });

  it('keeps the same guest-style bot for every game of a series, whatever the game\'s own id', () => {
    const game = (matchId: string, seriesId?: string | null) => opponentIdentity({ opponent: bot, opponentUser: botUser, matchId, seriesId, viewerIsGuest: true, rp: 1 });
    expect(game('m-1', 's-1')).toEqual(game('m-2', 's-1'));
    expect(game('m-1', 's-1').username).toBe(guestNameCandidates('grid-bot:s-1', 1)[0]);
    expect(game('m-1', 's-2').username).not.toBe(game('m-1', 's-1').username);
    expect(game('m-1', null).username).toBe(guestNameCandidates('grid-bot:m-1', 1)[0]);
  });

  it('keeps the real identity for members and for human opponents of guests', () => {
    expect(opponentIdentity({ opponent: bot, opponentUser: botUser, matchId: 'm-1', viewerIsGuest: false, rp: 1234 }))
      .toEqual({ id: 'bot-1', username: 'lukaberidze', avatarUrl: 'https://img/bot.png', avatarCustomization: { jersey: 'jersey_red' }, rp: 1234 });
    const human = { userId: 'human-1', isBot: false };
    expect(opponentIdentity({ opponent: human, opponentUser: { ...botUser, nickname: 'Masked Keeper 4321' }, matchId: 'm-1', viewerIsGuest: true, rp: undefined }).username)
      .toBe('Masked Keeper 4321');
  });
});
