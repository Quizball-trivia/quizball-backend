import { describe, expect, it } from 'vitest';
import { clientCanPlay, currentRoomEngine, roomEngineFor } from '../../src/modules/room/room.registry.js';
import type { RoomGameId } from '../../src/modules/room/room.types.js';

describe('room engine registry', () => {
  it('finds an engine by game and version, and nothing for a version this build does not have', () => {
    const engine = currentRoomEngine('aproximado');
    expect(roomEngineFor('aproximado', engine.version)).toBe(engine);
    expect(roomEngineFor('aproximado', engine.version + 1)).toBeNull();
    expect(roomEngineFor('unknown_game', 1)).toBeNull();
  });

  it('the first game needs no capability; any newer game must be named by the client', () => {
    expect(clientCanPlay('aproximado', undefined)).toBe(true);
    const newer = 'a_newer_game' as RoomGameId;
    expect(clientCanPlay(newer, undefined)).toBe(false);
    expect(clientCanPlay(newer, ['aproximado'])).toBe(false);
    expect(clientCanPlay(newer, ['aproximado', 'a_newer_game'])).toBe(true);
  });

  it('the Aproximado engine refuses content that is not its own and reports a terminal phase once', () => {
    const engine = currentRoomEngine('aproximado');
    expect(engine.parseContent({ questions: [] })).toBeNull();
    expect(engine.terminal({ phase: 'guess', deadline: 0, status: ['in', 'in'] } as never)).toBeNull();
    expect(engine.terminal({ phase: 'over', deadline: 0, status: ['in', 'in'] } as never)).toBe('completed');
    expect(engine.terminal({ phase: 'cancelled', deadline: 0, status: ['in', 'in'] } as never)).toBe('cancelled');
  });
});
