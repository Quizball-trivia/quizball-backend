import { describe, expect, it } from 'vitest';
import { config } from '../../src/core/config.js';
import { guestCompatibleInitialMode, normalizedModeForMemberCount, validateGuestLobby } from '../../src/realtime/services/lobby-guest-rules.js';

const m = (id: string, guest = false) => ({ user_id: id, is_guest: guest });
const flags = config as unknown as { FOOTBALL_GRID_LOBBY_ENABLED: boolean };

describe('lobby guest rules', () => {
  it('never constrains rooms without guests', () => {
    expect(validateGuestLobby([m('a'), m('b'), m('c')], 'friendly_party_quiz')).toBeNull();
    expect(validateGuestLobby([m('a')], 'friendly_possession')).toBeNull();
  });

  it('locks Friendly match and Party quiz as soon as a guest is present', () => {
    expect(validateGuestLobby([m('a'), m('g', true)], 'friendly_possession')?.code).toBe('LOBBY_MODE_REQUIRES_ACCOUNT');
    expect(validateGuestLobby([m('a'), m('g', true), m('b')], 'friendly_party_quiz')?.code).toBe('LOBBY_MODE_REQUIRES_ACCOUNT');
    for (const mode of ['football_grid', 'auction', 'ranked_sim'] as const) {
      expect(validateGuestLobby([m('a'), m('g', true)], mode), mode).toBeNull();
    }
  });

  it('caps guests at three and enforces the mode capacity for the resulting room', () => {
    expect(validateGuestLobby([m('g1', true), m('g2', true), m('g3', true)], 'auction')).toBeNull();
    expect(validateGuestLobby([m('g1', true), m('g2', true), m('g3', true), m('g4', true)], 'auction')?.code).toBe('LOBBY_GUEST_LIMIT');
    expect(validateGuestLobby([m('a'), m('b'), m('g', true)], 'football_grid')?.code).toBe('LOBBY_FULL');
  });

  it('mirrors the join normalization: a third member in a non-auction/grid room becomes party quiz', () => {
    expect(normalizedModeForMemberCount('ranked_sim', 3)).toBe('friendly_party_quiz');
    expect(normalizedModeForMemberCount('auction', 3)).toBe('auction');
    expect(normalizedModeForMemberCount('football_grid', 2)).toBe('football_grid');
    // …so a guest joining a two-member ranked-sim room is refused, not silently moved to a locked mode.
    expect(validateGuestLobby([m('a'), m('b'), m('g', true)], normalizedModeForMemberCount('ranked_sim', 3))?.code).toBe('LOBBY_MODE_REQUIRES_ACCOUNT');
  });

  it('opens guest-hosted rooms in a playable mode, honoring the grid flag', () => {
    const before = flags.FOOTBALL_GRID_LOBBY_ENABLED;
    flags.FOOTBALL_GRID_LOBBY_ENABLED = true;
    expect(guestCompatibleInitialMode()).toBe('football_grid');
    flags.FOOTBALL_GRID_LOBBY_ENABLED = false;
    expect(guestCompatibleInitialMode()).toBe('auction');
    flags.FOOTBALL_GRID_LOBBY_ENABLED = before;
  });
});
