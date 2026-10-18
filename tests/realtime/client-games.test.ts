import { describe, expect, it, vi } from 'vitest';
import { declaredGames, declares, isGated, joinLegacyRooms, legacyRoom, membersCanDraw, toCapable } from '../../src/realtime/client-games.js';

describe('client games', () => {
  it('cleans the handshake declaration', () => {
    expect(declaredGames(['tenable', 'name_chain', 'tenable', 7, '', 'x'.repeat(40)])).toEqual(['tenable', 'name_chain']);
    expect(declaredGames('tenable')).toEqual([]);
    expect(declaredGames(Array.from({ length: 40 }, (_, i) => `g${i}`))).toHaveLength(16);
  });

  it('only gated games need a declaration', () => {
    expect(isGated('tenable')).toBe(true);
    expect(isGated('name_chain')).toBe(false);
    expect(declares({}, 'name_chain')).toBe(true);
    expect(declares({}, null)).toBe(true);
    expect(declares({}, 'tenable')).toBe(false);
    expect(declares({ games: ['tenable'] }, 'tenable')).toBe(true);
  });

  it('an old tab joins the legacy room of every gated game it did not declare', () => {
    const old = { data: {}, join: vi.fn() };
    const fresh = { data: { games: ['tenable', 'football_race', 'codenames'] }, join: vi.fn() };
    joinLegacyRooms(old);
    joinLegacyRooms(fresh);
    expect(old.join).toHaveBeenCalledWith(legacyRoom('tenable'));
    expect(old.join).toHaveBeenCalledWith(legacyRoom('football_race'));
    expect(old.join).toHaveBeenCalledWith(legacyRoom('codenames'));
    expect(fresh.join).not.toHaveBeenCalled();
  });

  it('broadcasts of a gated game skip the legacy room; others do not', () => {
    const except = vi.fn(() => 'filtered');
    const io = { to: vi.fn(() => ({ except })) } as never;
    expect(toCapable(io, 'user:1', 'tenable')).toBe('filtered');
    expect(except).toHaveBeenCalledWith('caps:no-tenable');
    const plain = { marker: true };
    expect(toCapable({ to: () => plain } as never, 'user:1', 'name_chain')).toBe(plain);
  });

  it('members can draw: each online member needs one capable tab; offline members pass; errors refuse', async () => {
    const sockets: Record<string, Array<{ data: { games?: string[] } }>> = {
      'user:a': [{ data: { games: ['tenable'] } }, { data: {} }],
      'user:b': [{ data: {} }],
      'user:c': [],
    };
    const io = { in: (room: string) => ({ fetchSockets: async () => sockets[room] ?? [] }) } as never;
    expect(await membersCanDraw(io, ['a', 'c'], 'tenable')).toBe(true);
    expect(await membersCanDraw(io, ['a', 'b'], 'tenable')).toBe(false);
    expect(await membersCanDraw(io, ['b'], 'name_chain')).toBe(true);
    const broken = { in: () => ({ fetchSockets: async () => { throw new Error('adapter timeout'); } }) } as never;
    expect(await membersCanDraw(broken, ['a'], 'tenable')).toBe(false);
  });
});
