import { describe, expect, it } from 'vitest';
import { draftPacks, setActiveReleaseForTests } from '../../src/modules/draft/draft.content.js';
import { draftRoomEngine as engine, type DraftRoomContent, type DraftRoomState } from '../../src/modules/room/games/draft/draft.room.js';
import { inventedUniverse } from './draft.fixture.js';
import { activeSeatOf } from './draft.room.helpers.js';

const u = inventedUniverse();
draftPacks.set('r', u);
setActiveReleaseForTests('r');
const content = (variant: 'budget' | 'classic' | 'knowledge' = 'classic'): DraftRoomContent => ({ setup: { release: 'r', leagueId: 'sol', era: 'all', formation: '4-3-3', variant, seed: 'room-seed' }, universe: u });
const NOW = 1_000_000;

function playOut(c: DraftRoomContent, seats: number) {
  let s: DraftRoomState = engine.start(seats, c, NOW);
  let t = NOW;
  for (let i = 0; i < 200 && s.phase === 'picking'; i++) {
    t = s.deadline;
    s = engine.tick(s, c, t);
  }
  return s;
}

describe('the draft room', () => {
  it('runs out on the clock: everyone has eleven places, nobody signs the same person twice', () => {
    for (const seats of [2, 3, 4, 6]) {
      const s = playOut(content(), seats);
      expect(s.phase).toBe('over');
      for (const row of s.picks) {
        expect(row.every(Boolean)).toBe(true);
        const people = row.filter((p) => p && !p.academy).map((p) => p!.player.personId);
        expect(new Set(people).size).toBe(people.length);
      }
      expect(s.seasons).toHaveLength(seats);
      expect(engine.terminal(s)).toBe('completed');
    }
  });
  it('two seats end in a tie, more in a table', () => {
    expect(playOut(content(), 2).tie).not.toBeNull();
    expect(playOut(content(), 3).tie).toBeNull();
  });
  it('only the seat on the clock can sign, on its own turn', () => {
    const c = content();
    const s = engine.start(2, c, NOW);
    const on = activeSeatOf(s);
    const view = engine.view(s, c, on, 'en') as { spin: { players: Array<{ id: string; pos: string }> } };
    const id = view.spin.players.find((p) => p.pos === 'FWD')!.id;
    expect(engine.apply(s, c, 1 - on, { type: 'pick', round: 0, turn: 0, playerId: id }, NOW).error).toBe('not_your_turn');
    expect(engine.apply(s, c, on, { type: 'pick', round: 3, turn: 0, playerId: id }, NOW).error).toBe('stale_turn');
    const ok = engine.apply(s, c, on, { type: 'pick', round: 0, turn: 0, playerId: id }, NOW);
    expect(ok.error).toBeUndefined();
    expect(ok.state.taken).toHaveLength(1);
    expect(engine.apply(ok.state, c, activeSeatOf(ok.state), { type: 'pick', round: 0, turn: 1, playerId: id }, NOW).error).toBe('invalid_pick');
  });
  it('a player taken is gone for the other seat', () => {
    const c = content();
    const s = engine.start(3, c, NOW);
    const on = activeSeatOf(s);
    const view = engine.view(s, c, on, 'en') as { spin: { players: Array<{ id: string; pos: string }> } };
    const next = engine.apply(s, c, on, { type: 'pick', round: 0, turn: 0, playerId: view.spin.players[2].id }, NOW).state;
    const seen = engine.view(next, c, 0, 'en') as { taken: Array<{ playerId: string }> };
    expect(seen.taken.map((t) => t.playerId)).toContain(view.spin.players[2].id);
  });
  it('Ball Knowledge shows no ratings until the end, and letting the clock run out is no smarter than choosing', () => {
    const c = content('knowledge');
    const s = engine.start(2, c, NOW);
    const view = engine.view(s, c, 0, 'en') as { spin: { players: Array<{ id: string; name: string; rating: number; goals: number }> } };
    expect(view.spin.players.every((p) => p.rating === 0 && p.goals === 0)).toBe(true);
    expect(view.spin.players.every((p) => /^[0-9a-f]{16}$/.test(p.id))).toBe(true);
    const timedOut = engine.tick(s, c, s.deadline);
    const signed = timedOut.picks.flat().filter(Boolean);
    expect(signed).toHaveLength(1);
    const first = u.clubSeason(s.spinId)!.players.slice().sort((a, b) => a.name.localeCompare(b.name))[0];
    expect(signed[0]!.player.name <= first.name || signed[0]!.player.pos !== first.pos).toBe(true);
    const done = playOut(c, 2);
    const end = engine.view(done, c, 0, 'en') as { picks: Array<Array<{ player: { rating: number } } | null>> };
    expect(end.picks[0].some((p) => (p?.player.rating ?? 0) > 0)).toBe(true);
  });
  it('someone who left never wins, and a seat on the clock that left ends its turn at once', () => {
    const c = content();
    let s = engine.start(2, c, NOW);
    const on = activeSeatOf(s);
    s = engine.seatsChanged(s, [{ seat: on, change: 'leave' }], NOW + 10);
    expect(s.deadline).toBeLessThanOrEqual(NOW + 10 + 400);
    let t = NOW + 10;
    for (let i = 0; i < 100 && s.phase === 'picking'; i++) { t = s.deadline; s = engine.tick(s, c, t); }
    expect(s.winner).toBe(1 - on);
    expect(engine.standings(s)[0].seat).toBe(1 - on);
  });
  it('a seat that left cannot sign', () => {
    const c = content();
    const s = engine.start(2, c, NOW);
    const on = activeSeatOf(s);
    const gone = engine.seatsChanged(s, [{ seat: on, change: 'leave' }], NOW);
    const view = engine.view(gone, c, on, 'en') as { spin: { players: Array<{ id: string }> } };
    expect(engine.apply(gone, c, on, { type: 'pick', round: 0, turn: 0, playerId: view.spin.players[0].id }, NOW).error).toBe('left_match');
  });
  it('everyone leaving cancels the match', () => {
    const c = content();
    const s = engine.seatsChanged(engine.start(2, c, NOW), [{ seat: 0, change: 'leave' }, { seat: 1, change: 'leave' }], NOW);
    expect(engine.terminal(s)).toBe('cancelled');
  });
  it('an outage gives the turn a fresh clock and a budget room waits for the academy choice on the clock', () => {
    const c = content('budget');
    const s = engine.start(2, c, NOW);
    expect(engine.afterOutage(s, c, NOW + 50_000).deadline).toBeGreaterThan(NOW + 50_000);
    const done = playOut(c, 4);
    expect(done.phase).toBe('over');
    const view = engine.view(done, c, 0, 'en') as { budget: unknown };
    expect(view.budget).toBeNull();
  });
  it('options: defaults, valid choices, refuses anything else', () => {
    expect(engine.parseOptions(null)).toMatchObject({ variant: 'budget' });
    expect(engine.parseOptions({ leagueId: 'sol', era: 'modern', formation: '3-5-2', variant: 'classic' })).toMatchObject({ era: 'modern' });
    expect(engine.parseOptions({ leagueId: 'sol', era: 'nope', formation: '3-5-2', variant: 'classic' })).toBeUndefined();
  });
  it('deals a fresh seed on the active release with no pool rows', async () => {
    const a = await engine.deal((async () => []) as never, { leagueId: 'sol', era: 'all', formation: '4-3-3', variant: 'budget' }, 2);
    const b = await engine.deal((async () => []) as never, { leagueId: 'sol', era: 'all', formation: '4-3-3', variant: 'budget' }, 2);
    expect(a?.itemIds).toEqual([]);
    expect((a!.content as { setup: { seed: string } }).setup.seed).not.toBe((b!.content as { setup: { seed: string } }).setup.seed);
    expect(await engine.deal((async () => []) as never, { leagueId: 'nope', era: 'all', formation: '4-3-3', variant: 'budget' }, 2)).toBeNull();
  });
  it('hydrate under the lock uses only what is in memory', async () => {
    draftPacks.set('r', u);
    const raw = engine.parseContent({ setup: content().setup })!;
    expect((await engine.hydrate!(raw, null)).universe).toBe(u);
    await expect(engine.hydrate!({ setup: { ...raw.setup, release: 'cold' }, universe: null }, null, {} as never)).rejects.toThrow();
  });
});
