import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../../src/core/config.js';
import { anyRoomGameEnabled, isRoomGameEnabled } from '../../src/modules/room/room.config.js';

const flags = config as unknown as { ROOM_GAMES_ENABLED: string[]; ROOM_GAMES_DISABLED: string[] };
const original = { enabled: [...(flags.ROOM_GAMES_ENABLED ?? [])], disabled: [...(flags.ROOM_GAMES_DISABLED ?? [])] };
afterEach(() => { flags.ROOM_GAMES_ENABLED = [...original.enabled]; flags.ROOM_GAMES_DISABLED = [...original.disabled]; });

describe('which room games are on', () => {
  it('the word games need no configuration; the others are named', () => {
    flags.ROOM_GAMES_ENABLED = [];
    flags.ROOM_GAMES_DISABLED = [];
    expect(isRoomGameEnabled('shared_player')).toBe(true);
    expect(isRoomGameEnabled('name_chain')).toBe(true);
    expect(isRoomGameEnabled('aproximado')).toBe(false);
    expect(anyRoomGameEnabled()).toBe(true);
    flags.ROOM_GAMES_ENABLED = ['aproximado'];
    expect(isRoomGameEnabled('aproximado')).toBe(true);
    expect(isRoomGameEnabled('not_a_game')).toBe(false);
  });

  it('the kill switch wins over the default and over the list', () => {
    flags.ROOM_GAMES_ENABLED = ['aproximado'];
    flags.ROOM_GAMES_DISABLED = ['shared_player', 'aproximado'];
    expect(isRoomGameEnabled('shared_player')).toBe(false);
    expect(isRoomGameEnabled('aproximado')).toBe(false);
    expect(isRoomGameEnabled('name_chain')).toBe(true);
    flags.ROOM_GAMES_DISABLED = ['shared_player', 'name_chain', 'aproximado'];
    expect(anyRoomGameEnabled()).toBe(false);
  });
});
