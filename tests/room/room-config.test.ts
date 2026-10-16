import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../../src/core/config.js';
import { ROOM_GAMES } from '../../src/modules/room/room.types.js';
import { anyRoomGameEnabled, isRoomGameEnabled } from '../../src/modules/room/room.config.js';

const flags = config as unknown as { ROOM_GAMES_DISABLED: string[] };
const original = [...(flags.ROOM_GAMES_DISABLED ?? [])];
afterEach(() => { flags.ROOM_GAMES_DISABLED = [...original]; });

describe('which room games are on', () => {
  it('every room game is on without any configuration', () => {
    flags.ROOM_GAMES_DISABLED = [];
    for (const game of ROOM_GAMES) expect(isRoomGameEnabled(game)).toBe(true);
    expect(isRoomGameEnabled('not_a_game')).toBe(false);
    expect(anyRoomGameEnabled()).toBe(true);
  });

  it('the kill switch turns one off', () => {
    flags.ROOM_GAMES_DISABLED = ['shared_player', 'aproximado'];
    expect(isRoomGameEnabled('shared_player')).toBe(false);
    expect(isRoomGameEnabled('aproximado')).toBe(false);
    expect(isRoomGameEnabled('name_chain')).toBe(true);
    flags.ROOM_GAMES_DISABLED = [...ROOM_GAMES];
    expect(anyRoomGameEnabled()).toBe(false);
  });
});
