import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mentalistaRoomEngine, MENTALISTA_PACK_WANTED } from '../../src/modules/room/games/mentalista/mentalista.room.js';
import {
  ROOM_GAMES, ROOM_GAME_MIN_SEATS, isRoomGame, roomGameMinSeats, roomGameSeats,
} from '../../src/modules/room/room.types.js';
import type { RoomPoolItem } from '../../src/modules/room/room.repo.js';

/**
 * Wiring tests. These import only the pure engine/rules/room-adapter modules and the room.types enum (all zod-only);
 * the registry and lobby modules pull in config that reads .env, so their wiring is checked by reading committed source
 * rather than importing it — no DB client, config load or network. Fixtures are an invented universe, never real content.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, '../../src', p), 'utf8');

const L = (s: string) => ({ es: s, en: s, ka: s, tr: s });
const category = (id: string, difficulty: 'easy' | 'medium' | 'hard') => ({
  id, difficulty, prompt: L(`prompt-${id}`),
  options: Array.from({ length: 4 }, (_, i) => ({ id: `${id}-${i}`, name: L(`${id}-${i}`) })),
});
const poolItem = (item_id: string, difficulty: 'easy' | 'medium' | 'hard'): RoomPoolItem =>
  ({ item_id, difficulty, payload: category(item_id, difficulty) });
const POOL: RoomPoolItem[] = [
  poolItem('e1', 'easy'), poolItem('e2', 'easy'),
  poolItem('m1', 'medium'), poolItem('m2', 'medium'),
  poolItem('h1', 'hard'), poolItem('h2', 'hard'),
];

describe('mentalista registration: room.types enum and seat gates', () => {
  it('is a known room game needing three seats, capped at the default six', () => {
    expect(ROOM_GAMES).toContain('mentalista');
    expect(isRoomGame('mentalista')).toBe(true);
    expect(ROOM_GAME_MIN_SEATS.mentalista).toBe(3);
    expect(roomGameMinSeats('mentalista')).toBe(3); // a chooser plus at least two predictors
    expect(roomGameSeats('mentalista', 8)).toBe(6); // no own cap → default six
    expect(roomGameSeats('mentalista', 4)).toBe(4); // never above the mode ceiling
  });
});

describe('mentalista registration: the room engine adapter', () => {
  const engine = mentalistaRoomEngine;

  it('declares its id, version and a command schema that matches the wire protocol', () => {
    expect(engine.game).toBe('mentalista');
    expect(engine.version).toBe(1);
    expect(engine.commandSchema.safeParse({ type: 'choose', round: 0, option: 0 }).success).toBe(true);
    expect(engine.commandSchema.safeParse({ type: 'predict', round: 2, option: 3 }).success).toBe(true);
    expect(engine.commandSchema.safeParse({ type: 'guess', round: 0, value: 1 }).success).toBe(false);
    expect(engine.terminal({ phase: 'over' } as never)).toBe('completed');
    expect(engine.terminal({ phase: 'cancelled' } as never)).toBe('cancelled');
    expect(engine.terminal({ phase: 'choose' } as never)).toBeNull();
  });

  it('parses legal content/options and rejects foreign ones', () => {
    const options = engine.parseOptions(null);
    expect(options).toEqual({ chooseMs: 20_000, predictMs: 20_000, revealMs: 5_000 });
    // Host options are FLAT: a top-level clock is tuned and bounded; a nested { timing: {...} } blob is not these options.
    expect(engine.parseOptions({ chooseMs: 30_000 })).toEqual({ chooseMs: 30_000, predictMs: 20_000, revealMs: 5_000 });
    expect(engine.parseOptions({ chooseMs: 4_999 })).toBeUndefined(); // flat, below bound
    expect(engine.parseOptions({ timing: { chooseMs: 20_000 } })).toBeUndefined(); // nested blob rejected
    const content = { timing: options, categories: [category('a', 'easy'), category('b', 'medium'), category('c', 'hard')] };
    expect(engine.parseContent(content)).not.toBeNull();
    expect(engine.parseContent({ timing: options, categories: [] })).toBeNull();
    expect(engine.parseContent({ questions: [] })).toBeNull();
  });

  it('deals a distinct category per round for every admitted size, and refuses a short pool', async () => {
    const options = engine.parseOptions(null)!;
    const pick = async () => POOL;
    for (const seats of [3, 4, 5, 6]) {
      const dealt = await engine.deal(pick, options, seats);
      expect(dealt).not.toBeNull();
      expect(dealt!.itemIds).toHaveLength(seats);
      expect(new Set(dealt!.itemIds).size).toBe(seats); // distinct pool items
      const parsed = engine.parseContent(dealt!.content);
      expect(parsed).not.toBeNull();
      expect((parsed as { categories: unknown[] }).categories).toHaveLength(seats);
    }
    expect(MENTALISTA_PACK_WANTED).toEqual({ easy: 2, medium: 2, hard: 2 });
    const short = await engine.deal(async () => POOL.slice(0, 2), options, 3);
    expect(short).toBeNull(); // fewer distinct categories than seats → cannot start
  });
});

describe('mentalista registration: wiring held in modules that read config (source assertions)', () => {
  it('room.registry registers the engine as current and by version', () => {
    const registry = src('modules/room/room.registry.ts');
    expect(registry).toContain("import { mentalistaRoomEngine } from './games/mentalista/mentalista.room.js';");
    expect(registry).toContain('mentalista: mentalistaRoomEngine as unknown as AnyRoomEngine');
    expect(registry).toContain('mentalista: { [mentalistaRoomEngine.version]: mentalistaRoomEngine as unknown as AnyRoomEngine }');
  });

  it('lobby-modes raises a room game’s host-start minimum to the game’s own (Mentalista needs three)', () => {
    const lobby = src('modules/lobbies/lobby-modes.ts');
    expect(lobby).toContain('Math.max(shape.min, roomGameMinSeats(roomGame))');
    expect(lobby).toContain('roomGameSeats(roomGame, shape.max)');
  });

  it('room.types lists mentalista and its three-seat minimum', () => {
    const types = src('modules/room/room.types.ts');
    expect(types).toContain("'mentalista'");
    expect(types).toContain('mentalista: 3');
  });

  it('the shared lobby options transport carries flat primitives only, so nested timing cannot reach the game', () => {
    // lobbyRoomOptionsSchema is a record of flat string/number/boolean values — a nested { timing: {...} } object is
    // not a permitted value, which is exactly why Mentalista's host options are flat clocks (not a nested blob).
    const schemas = src('realtime/schemas/lobby.schemas.ts');
    expect(schemas).toContain('export const lobbyRoomOptionsSchema');
    expect(schemas).toContain('z.record(z.union([z.string().max(32), z.number(), z.boolean()]))');
  });
});
