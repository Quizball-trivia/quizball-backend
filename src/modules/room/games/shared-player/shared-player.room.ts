import { z } from 'zod';
import { footballersService } from '../../../footballers/footballers.service.js';
import type { RoomEngine, RoomPoolPick } from '../../room.engine.js';
import { refusedForPair } from '../../../wordgame-reports/wordgame-reports.rules.js';
import {
  afterOutage, PACK_PAIRS, seatsChanged, sharedPlayerCommandSchema, sharedPlayerItemSchema, sharedPlayerPackSchema, standings, startMatch, submitAnswer, tick, viewOf,
  type SharedPlayerCommand, type SharedPlayerContent, type SharedPlayerItem, type SharedPlayerState,
} from './shared-player.engine.js';

/** Which clubs a match draws from: every well-known club, Turkish clubs against Europe, or one league. */
export const SHARED_PLAYER_SCOPES = ['mixed', 'tr-eu', 'TR', 'ENG', 'ESP', 'ITA', 'GER', 'FRA'] as const;
export type SharedPlayerScope = (typeof SHARED_PLAYER_SCOPES)[number];
export const SHARED_PLAYER_DIFFICULTIES = ['easy', 'medium'] as const;

export const sharedPlayerOptionsSchema = z.object({
  scope: z.enum(SHARED_PLAYER_SCOPES).default('mixed'),
  /** Absent = a match that opens easy and gets harder. */
  difficulty: z.enum(SHARED_PLAYER_DIFFICULTIES).optional(),
}).strict();
export type SharedPlayerOptions = z.infer<typeof sharedPlayerOptionsSchema>;
export const DEFAULT_SHARED_PLAYER_OPTIONS: SharedPlayerOptions = { scope: 'mixed' };

/** Easy pairs open a match, the harder ones close it. */
export const SHARED_PLAYER_PACK_WANTED = { easy: 4, medium: 6 } as const;
/** Asked from the pool per pair wanted: room to keep one club from meeting everyone. */
const OVERSAMPLE = 3;
const MAX_PER_CLUB = 2;

/** `wanted` pairs of one release, no club more than twice in the match (`used` counts across calls); null when the picks cannot fill it. */
function choose(items: SharedPlayerItem[], wanted: number, used: Map<string, number>): SharedPlayerItem[] | null {
  const releases = new Map<string, number>();
  for (const item of items) releases.set(item.release, (releases.get(item.release) ?? 0) + 1);
  // A pool mid-way between two releases: the one with more enabled pairs is the current one.
  const release = [...releases].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0]?.[0];
  const pool = items.filter((item) => item.release === release);
  const picked: SharedPlayerItem[] = [];
  const take = (cap: number) => {
    for (const item of pool) {
      if (picked.length >= wanted) return;
      if (picked.includes(item) || (used.get(item.a.key) ?? 0) >= cap || (used.get(item.b.key) ?? 0) >= cap) continue;
      picked.push(item);
      used.set(item.a.key, (used.get(item.a.key) ?? 0) + 1);
      used.set(item.b.key, (used.get(item.b.key) ?? 0) + 1);
    }
  };
  take(MAX_PER_CLUB);
  // A small scope cannot always keep the cap: better a repeated club than no match.
  take(Number.POSITIVE_INFINITY);
  return picked.length === wanted ? picked : null;
}

export async function dealSharedPlayer(pick: RoomPoolPick, options: SharedPlayerOptions = DEFAULT_SHARED_PLAYER_OPTIONS): Promise<{ itemIds: string[]; content: unknown } | null> {
  // One difficulty when the host chose it; otherwise the default mix.
  const mix: Record<string, number> = options.difficulty ? { [options.difficulty]: PACK_PAIRS } : SHARED_PLAYER_PACK_WANTED;
  const items = await pick(Object.fromEntries(Object.entries(mix).map(([difficulty, n]) => [difficulty, n * OVERSAMPLE])), options.scope);
  const parsed = (difficulty: string) => items.filter((item) => item.difficulty === difficulty)
    .flatMap((item) => { const p = sharedPlayerItemSchema.safeParse(item.payload); return p.success ? [p.data] : []; });
  const pairs: SharedPlayerItem[] = [];
  const used = new Map<string, number>();
  for (const difficulty of ['easy', 'medium']) {
    const wanted = mix[difficulty] ?? 0;
    if (!wanted) continue;
    // Every part must be of the release the first part settled on.
    const part = choose(parsed(difficulty).filter((item) => pairs.length === 0 || item.release === pairs[0].release), wanted, used);
    if (!part) return null;
    pairs.push(...part);
  }
  if (pairs.length !== PACK_PAIRS) return null;
  return { itemIds: pairs.map((pair) => pair.id), content: { release: pairs[0].release, pairs } };
}

export const sharedPlayerRoomEngine: RoomEngine<SharedPlayerContent, SharedPlayerState, SharedPlayerCommand, SharedPlayerOptions> = {
  game: 'shared_player',
  version: 1,
  commandSchema: sharedPlayerCommandSchema,

  parseContent(raw) {
    const parsed = sharedPlayerPackSchema.safeParse(raw);
    return parsed.success ? { pack: parsed.data, universe: null } : null;
  },

  /** No options = the default scope; options that are not this game's are refused. */
  parseOptions(raw) {
    if (raw === null || raw === undefined) return DEFAULT_SHARED_PLAYER_OPTIONS;
    const parsed = sharedPlayerOptionsSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  },

  deal: (pick, options) => dealSharedPlayer(pick, options),

  async hydrate(content) {
    return content.universe ? content : { pack: content.pack, universe: await footballersService.universe(content.pack.release) };
  },

  start: (seats, _content, nowMs) => startMatch(seats, nowMs),
  tick: (state, _content, nowMs) => tick(state, nowMs),
  afterOutage: (state, _content, nowMs) => afterOutage(state, nowMs),
  seatsChanged: (state, changes) => seatsChanged(state, changes),
  apply: (state, content, seat, command, nowMs) => submitAnswer(state, content, seat, command, nowMs),
  terminal: (state) => (state.phase === 'over' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : null),
  standings: (state) => standings(state),
  view: (state, content, seat, locale) => viewOf(state, content, seat, locale),

  /** Only a pair whose answers the room has already seen. */
  refusal(state, content, round, text) {
    const pair = content.pack.pairs[round];
    if (!pair || !content.universe || round >= state.results.length) return null;
    return refusedForPair(content.universe, pair, text);
  },
};
