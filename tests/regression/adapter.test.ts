import { describe, expect, it, vi } from 'vitest';
import { FakeIo, createTrace } from '../../game-regression/src/adapter.mjs';

describe('harness adapter + recorder', () => {
  it('records room emits with their target room', () => {
    const trace = createTrace(() => 1000);
    const io = new FakeIo(trace);
    io.to('match:m1').emit('match:state', { phase: 'NORMAL_PLAY' });
    io.to('user:u1').emit('match:rejoin_available', { matchId: 'm1' });
    expect(trace.byEvent('match:state', 'match:m1')).toHaveLength(1);
    expect(trace.byEvent('match:rejoin_available', 'user:u1')).toHaveLength(1);
    expect(trace.last('match:state')?.payload).toEqual({ phase: 'NORMAL_PLAY' });
  });

  it('records per-socket emits tagged with the socket id', () => {
    const trace = createTrace(() => 2000);
    const io = new FakeIo(trace);
    const s = io.createSocket('sock-1', { user: { id: 'u1' } });
    s.emit('error', { code: 'X' });
    const recorded = trace.byEvent('error', 'sock-1');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].dir).toBe('server->socket');
  });

  it('fetchSockets returns sockets in a room with id/data the engine reads', async () => {
    const trace = createTrace(() => vi.getMockedSystemTime?.()?.getTime?.() ?? 0);
    const io = new FakeIo(trace);
    const a = io.createSocket('a', { user: { id: 'ua' }, connectedAt: 0 });
    io.createSocket('b', { user: { id: 'ub' }, connectedAt: 0 });
    a.join('match:m1');
    const inMatch = await io.in('match:m1').fetchSockets();
    expect(inMatch.map((s) => s.id)).toEqual(['a']);
    expect(inMatch[0].data.user.id).toBe('ua');
    expect(typeof inMatch[0].data.connectedAt).toBe('number');
  });

  it('leave removes a socket from a room; removeSocket drops it entirely', async () => {
    const trace = createTrace(() => 0);
    const io = new FakeIo(trace);
    const a = io.createSocket('a', { user: { id: 'ua' } });
    a.join('match:m1');
    a.leave('match:m1');
    expect(await io.in('match:m1').fetchSockets()).toHaveLength(0);
    a.join('match:m1');
    io.removeSocket(a);
    expect(await io.in('match:m1').fetchSockets()).toHaveLength(0);
  });

  it('preserves global event ordering across rooms and sockets', () => {
    const times = [10, 20, 30];
    let i = 0;
    const trace = createTrace(() => times[Math.min(i++, times.length - 1)]);
    const io = new FakeIo(trace);
    const s = io.createSocket('s', { user: { id: 'u' } });
    io.to('match:m1').emit('first', {});
    s.emit('second', {});
    io.emit('third', {});
    expect(trace.events.map((e) => e.event)).toEqual(['first', 'second', 'third']);
    expect(trace.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});
