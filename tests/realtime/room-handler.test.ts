import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

const handlePointer = vi.fn(async () => {});
const emitError = vi.fn();
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/realtime/services/duel-rate-limit.service.js', () => ({ allowDuelOperation: vi.fn(async () => true) }));
vi.mock('../../src/realtime/services/room-realtime.service.js', () => ({ roomRealtimeService: { handlePointer, emitError } }));

const { registerRoomHandlers } = await import('../../src/realtime/handlers/room.handler.js');

describe('room socket handlers', () => {
  it('room:pointer without a payload reaches the pointer lookup (no matchId to read)', async () => {
    const handlers = new Map<string, (payload?: unknown) => void>();
    const socket = { data: { user: { id: 'u1' } }, on: (event: string, fn: (payload?: unknown) => void) => handlers.set(event, fn), emit: vi.fn() };
    registerRoomHandlers({} as never, socket as never);
    handlers.get('room:pointer')!();
    await vi.waitFor(() => expect(handlePointer).toHaveBeenCalledWith(socket));
    expect(emitError).not.toHaveBeenCalled();
  });
});
