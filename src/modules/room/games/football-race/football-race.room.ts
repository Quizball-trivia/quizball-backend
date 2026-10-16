import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { RoomEngine } from '../../room.engine.js';
import {
  afterOutage, applyCommand, footballRaceCommandSchema, footballRacePackSchema, seatsChanged, standings, startMatch, tick, viewOf,
  type FootballRaceCommand, type FootballRaceContent, type FootballRaceState,
} from './football-race.engine.js';
import { loadRaceTournament } from './football-race.releases.js';
import { dealRace, MAX_SEATS, tournamentOrder } from './football-race.rules.js';

/** A pool item: one tournament of a published release. */
export const footballRaceItemSchema = z.object({
  id: z.string().min(1).max(64),
  release: z.string().regex(/^[0-9a-z][0-9a-z.-]{2,59}$/),
  tournament: z.string().regex(/^[A-Z0-9]{2,20}$/),
}).strict();

/** What the host chose: one tournament, or "random" (the big ones most often). */
export const footballRaceOptionsSchema = z.object({ tournament: z.union([z.literal('random'), z.string().regex(/^[A-Z0-9]{2,20}$/)]) }).strict();
export type FootballRaceOptions = z.infer<typeof footballRaceOptionsSchema>;

const MAX_CANDIDATES = 12;

export const footballRaceRoomEngine: RoomEngine<FootballRaceContent, FootballRaceState, FootballRaceCommand, FootballRaceOptions> = {
  game: 'football_race',
  version: 1,
  commandSchema: footballRaceCommandSchema,

  parseContent(raw) {
    const parsed = footballRacePackSchema.safeParse(raw);
    return parsed.success ? { pack: parsed.data, data: null } : null;
  },

  parseOptions(raw) {
    if (raw === null || raw === undefined) return { tournament: 'random' };
    const parsed = footballRaceOptionsSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  },

  /**
   * A tournament and a seed, checked here (before the match exists, outside any lock) so that the start deals a fair
   * group for every number of seats the ready gate could admit: 2 up to the room's members.
   */
  async deal(pick, options, seats) {
    // The whole pool (or the one tournament asked for), reordered by the seed below: who played what recently changes nothing.
    const items = (await pick({ easy: options.tournament === 'random' ? MAX_CANDIDATES : 1 }, options.tournament === 'random' ? undefined : options.tournament, { history: false }))
      .flatMap((item) => { const p = footballRaceItemSchema.safeParse(item.payload); return p.success ? [p.data] : []; });
    const seed = randomInt(0, 0x100000000);
    const order = tournamentOrder(items.map((i) => i.tournament), seed);
    const wanted = Math.min(Math.max(seats, 2), MAX_SEATS);
    for (const tournament of order) {
      const item = items.find((i) => i.tournament === tournament)!;
      const data = await loadRaceTournament(item.release, item.tournament);
      let fair = true;
      // Largest group first: it is the count a small tournament fails, so an unfair one is dropped after one scan.
      for (let n = wanted; n >= 2 && fair; n -= 1) fair = dealRace(data, n, seed)?.fair === true;
      if (fair) return { itemIds: [item.id], content: { release: item.release, tournament: item.tournament, seed } };
    }
    return null;
  },

  async hydrate(content, tx) {
    return content.data ? content : { pack: content.pack, data: await loadRaceTournament(content.pack.release, content.pack.tournament, tx) };
  },

  start: (seats, content, nowMs) => startMatch(seats, content, nowMs),
  tick: (state, content, nowMs) => tick(state, content, nowMs),
  afterOutage: (state, _content, nowMs) => afterOutage(state, nowMs),
  seatsChanged: (state, changes, nowMs) => seatsChanged(state, changes, nowMs),
  apply: (state, content, seat, command, nowMs) => applyCommand(state, content, seat, command, nowMs),
  terminal: (state) => (state.phase === 'over' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : null),
  standings: (state) => standings(state),
  view: (state, content, seat, locale) => viewOf(state, content, seat, locale),
};
