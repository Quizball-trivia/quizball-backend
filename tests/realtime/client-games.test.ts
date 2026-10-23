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
    const fresh = { data: { games: ['tenable', 'football_race', 'codenames', 'dato_falso', 'codenames@2', 'codenames@3'] }, join: vi.fn() };
    const picturesOnly = { data: { games: ['tenable', 'football_race', 'codenames', 'dato_falso'] }, join: vi.fn() };
    const noTimer = { data: { games: ['tenable', 'football_race', 'codenames', 'dato_falso', 'codenames@2'] }, join: vi.fn() };
    joinLegacyRooms(picturesOnly);
    // A tab from before Codenames word boards is kept out of version-2 (word) and version-3 (timer) matches only.
    expect(picturesOnly.join.mock.calls).toEqual([[legacyRoom('codenames@2')], [legacyRoom('codenames@3')]]);
    // A tab from before turn timers, out of version-3 matches only.
    joinLegacyRooms(noTimer);
    expect(noTimer.join.mock.calls).toEqual([[legacyRoom('codenames@3')]]);
    joinLegacyRooms(old);
    joinLegacyRooms(fresh);
    expect(old.join).toHaveBeenCalledWith(legacyRoom('tenable'));
    expect(old.join).toHaveBeenCalledWith(legacyRoom('football_race'));
    expect(old.join).toHaveBeenCalledWith(legacyRoom('codenames'));
    expect(old.join).toHaveBeenCalledWith(legacyRoom('dato_falso'));
    expect(old.join).toHaveBeenCalledWith(legacyRoom('codenames@2'));
    expect(fresh.join).not.toHaveBeenCalled();
  });

  it('broadcasts of a gated game skip the legacy room; others do not', () => {
    const except = vi.fn(() => 'filtered');
    const io = { to: vi.fn(() => ({ except })) } as never;
    expect(toCapable(io, 'user:1', 'tenable')).toBe('filtered');
    expect(except).toHaveBeenCalledWith('caps:no-tenable');
    const plain = { marker: true };
    expect(toCapable({ to: () => plain } as never, 'user:1', 'name_chain')).toBe(plain);
    // A Codenames word match (version 2) also skips the tabs that cannot draw word boards; a picture match does not.
    const second = vi.fn(() => 'words-only');
    const chain = { except: vi.fn(() => ({ except: second })) };
    expect(toCapable({ to: () => chain } as never, 'user:1', 'codenames', 2)).toBe('words-only');
    expect(chain.except).toHaveBeenCalledWith('caps:no-codenames');
    expect(second).toHaveBeenCalledWith('caps:no-codenames@2');
    const one = { except: vi.fn(() => 'pictures') };
    expect(toCapable({ to: () => one } as never, 'user:1', 'codenames', 1)).toBe('pictures');
    expect(one.except).toHaveBeenCalledTimes(1);
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
