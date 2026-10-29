import { randomInt } from 'node:crypto';
import { normalizeTyped } from '../../../footballers/footballers.text.js';
import { asD501Locale, d501CategorySchema, internCategory } from '../../../darts501/darts501.content.js';
import { darts501Coverage } from '../../../darts501/darts501.coverage.js';
import { D501, entriesOf, readDart } from '../../../darts501/darts501.rules.js';
import { tenableDirectories } from '../../../tenable/tenable.directories.js';
import { RoomContentUnavailable } from '../../../footballers/footballers.russian.js';
import type { RoomEngine } from '../../room.engine.js';
import {
  afterOutage, applyCommand, darts501CommandSchema, darts501PackSchema, legRevealed, LEGS, seatsChanged, standings, startMatch, tick, viewOf,
  type Darts501Command, type Darts501Content, type Darts501State,
} from './darts501.engine.js';

const TIERS = ['easy', 'medium', 'hard'] as const;

export const darts501RoomEngine: RoomEngine<Darts501Content, Darts501State, Darts501Command, null> = {
  game: 'darts501',
  version: 1,
  commandSchema: darts501CommandSchema,

  parseContent(raw) {
    const parsed = darts501PackSchema.safeParse(raw);
    return parsed.success ? { pack: { ...parsed.data, legs: parsed.data.legs.map(internCategory) }, boards: null } : null;
  },

  parseOptions: (raw) => (raw === null || raw === undefined ? null : undefined),

  /** One category of each tier, easiest first; the pool's picker prefers categories the seats have not been dealt lately. */
  async deal(pick) {
    const items = await pick(Object.fromEntries(TIERS.map((t) => [t, 1])));
    const legs = TIERS.map((tier) => items.find((item) => item.difficulty === tier)).flatMap((item) => {
      const parsed = item ? d501CategorySchema.safeParse(item.payload) : null;
      return parsed?.success ? [{ id: item!.item_id, category: parsed.data }] : [];
    });
    if (legs.length !== LEGS) return null;
    // Loaded here, before the match exists and outside any lock, so hydrating under the match lock never waits on a cold
    // load. A category whose names or coverage cannot be loaded is not dealt.
    const ready = await Promise.all(legs.map((l) => Promise.all([
      tenableDirectories.get('player', l.category.release),
      darts501Coverage.get(l.category.coverage),
    ]).then(() => true, () => false)));
    if (ready.includes(false)) return null;
    return { itemIds: legs.map((l) => l.id), content: { legs: legs.map((l) => l.category), seed: randomInt(0, 0x100000000) } };
  },

  /**
   * Under the match lock (`tx`) only what is in memory is used: a missing release or coverage is a retryable refusal and
   * the runtime prepares it before the lock on the next call, so no cold load ever holds a match lock.
   */
  async hydrate(content, _state, tx) {
    if (content.boards) return content;
    if (tx && content.pack.legs.some((c) => !tenableDirectories.loaded('player', c.release) || !darts501Coverage.loaded(c.coverage))) throw new RoomContentUnavailable();
    const boards = await Promise.all(content.pack.legs.map(async (category) => {
      const [directory, coverage] = await Promise.all([tenableDirectories.get('player', category.release), darts501Coverage.get(category.coverage)]);
      return { directory, coverage, entries: entriesOf(category) };
    }));
    return { pack: content.pack, boards };
  },

  start: (seats, content, nowMs) => startMatch(seats, content, nowMs),
  tick: (state, _content, nowMs) => tick(state, nowMs),
  afterOutage: (state, _content, nowMs) => afterOutage(state, nowMs),
  seatsChanged: (state, changes, nowMs) => seatsChanged(state, changes, nowMs),
  apply: (state, content, seat, command, nowMs) => applyCommand(state, content, seat, command, nowMs),
  terminal: (state) => (state.phase === 'over' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : null),
  standings: (state) => standings(state),
  view: (state, content, seat, locale) => viewOf(state, content, seat, asD501Locale(locale)),

  /**
   * A refused text is reportable only once its leg is over (never as a way to test numbers), and only when the leg's
   * category does not score it. The subject is the category; the resolved id is who the text was read as.
   */
  refusal(state, content, round, text) {
    if (!Number.isInteger(round) || round < 0 || round >= LEGS || !legRevealed(state, round) || !content.boards || !normalizeTyped(text)) return null;
    const category = content.pack.legs[round];
    const read = readDart(content.boards[round], new Set(), D501.start, text, null);
    if (!read.free && read.value !== null) return null;
    return { release: category.release, subject: category.id, resolvedPid: read.eid };
  },
};
