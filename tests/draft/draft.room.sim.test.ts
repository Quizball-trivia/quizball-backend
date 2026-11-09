import { describe, expect, it } from 'vitest';
import { rng, type Pick } from '../../src/modules/draft/draft.rules.js';
import { draftRoomEngine as engine, type DraftRoomContent, type DraftRoomState } from '../../src/modules/room/games/draft/draft.room.js';
import { inventedUniverse } from './draft.fixture.js';
import { activeSeatOf } from './draft.room.helpers.js';

const u = inventedUniverse();
const VARIANTS = ['budget', 'classic', 'knowledge'] as const;
const FORMATIONS = ['4-3-3', '4-4-2', '4-2-3-1', '3-5-2'] as const;

/** Simulated rooms: seats that sign, time out, go away, come back and leave, in random order. What must always hold is checked at every step. */
function simulate(seedText: string) {
  const r = rng(seedText);
  const seats = 2 + Math.floor(r() * 5);
  const variant = VARIANTS[Math.floor(r() * 3)];
  const content: DraftRoomContent = { setup: { release: 'r', leagueId: 'sol', era: 'all', formation: FORMATIONS[Math.floor(r() * 4)], variant, seed: seedText }, universe: u };
  let now = 1_000_000;
  let s: DraftRoomState = engine.start(seats, content, now);
  const left = new Set<number>();
  for (let step = 0; step < 900 && engine.terminal(s) === null; step++) {
    const dice = r();
    if (dice < 0.03 && left.size < seats) {
      const seat = Math.floor(r() * seats);
      if (!left.has(seat)) { left.add(seat); s = engine.seatsChanged(s, [{ seat, change: 'leave' }], now); }
    } else if (dice < 0.08) {
      const seat = Math.floor(r() * seats);
      if (!left.has(seat)) s = engine.seatsChanged(s, [{ seat, change: r() < 0.5 ? 'away' : 'back' }], now);
    } else if (dice < 0.3) {
      now = Math.max(now, s.deadline);
      s = engine.tick(s, content, now);
    } else {
      const seat = activeSeatOf(s);
      const view = engine.view(s, content, seat, 'en') as { spin: { players: Array<{ id: string; rating: number; price?: number }> } | null; budget: number | null };
      if (variant === 'knowledge') expect(view.spin!.players.every((p) => p.rating === 0 && p.price === undefined)).toBe(true);
      const choice = view.spin!.players[Math.floor(r() * view.spin!.players.length)];
      const wrongSeat = (seat + 1) % seats;
      if (seats > 1) expect(engine.apply(s, content, wrongSeat, { type: 'pick', round: s.round, turn: s.turn, playerId: choice.id }, now).state).toBe(s);
      const out = engine.apply(s, content, seat, { type: 'pick', round: s.round, turn: s.turn, playerId: choice.id }, now);
      s = out.error ? s : out.state;
    }
    for (const row of s.picks) expect(row).toHaveLength(11);
    if (variant === 'budget') for (const row of s.picks) expect(row.reduce((a, p) => a + (p?.price ?? 0), 0)).toBeLessThanOrEqual(300);
  }
  return { s, seats, left, content };
}

describe('simulated rooms', () => {
  it('always end, with a full and legal team for every seat, and someone who left never wins', () => {
    let finished = 0, cancelled = 0;
    for (let i = 0; i < 300; i++) {
      const { s, seats, left, content } = simulate(`sim-${i}`);
      expect(engine.terminal(s), `room ${i} did not end`).not.toBeNull();
      if (engine.terminal(s) === 'cancelled') { cancelled++; expect(left.size).toBe(seats); continue; }
      finished++;
      expect(s.seasons).toHaveLength(seats);
      for (const row of s.picks as (Pick | null)[][]) {
        expect(row.every(Boolean)).toBe(true);
        const people = row.filter((p) => p && !p.academy).map((p) => p!.player.personId);
        expect(new Set(people).size).toBe(people.length);
      }
      const everyId = (s.picks as (Pick | null)[][]).flat().filter((p) => p && !p.academy).map((p) => p!.player.id);
      expect(new Set(everyId).size).toBe(everyId.length);
      if (left.size < seats) {
        expect(left.has(s.winner!)).toBe(false);
        expect(left.has(engine.standings(s)[0].seat)).toBe(false);
      }
      expect(JSON.stringify(engine.view(s, content, 0, 'en'))).not.toContain(`sim-${i}`);
    }
    expect(finished).toBeGreaterThan(200);
    expect(cancelled).toBeGreaterThanOrEqual(0);
  });
});
