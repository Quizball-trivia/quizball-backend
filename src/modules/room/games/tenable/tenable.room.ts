import { randomInt } from 'node:crypto';
import { normalizeTyped } from '../../../footballers/footballers.text.js';
import { TENABLE_LOCALES, tenableListSchema, type TenableLocale } from '../../../tenable/tenable.content.js';
import { tenableDirectories } from '../../../tenable/tenable.directories.js';
import { judge } from '../../../tenable/tenable.identify.js';
import type { RoomEngine } from '../../room.engine.js';
import {
  afterOutage, applyCommand, listRevealed, LISTS, seatsChanged, standings, startMatch, tenableCommandSchema, tenablePackSchema, tick, viewOf,
  type TenableCommand, type TenableContent, type TenableState,
} from './tenable.engine.js';

const TIERS = ['easy', 'medium', 'hard'] as const;

export const tenableRoomEngine: RoomEngine<TenableContent, TenableState, TenableCommand, null> = {
  game: 'tenable',
  version: 1,
  commandSchema: tenableCommandSchema,

  parseContent(raw) {
    const parsed = tenablePackSchema.safeParse(raw);
    return parsed.success ? { pack: parsed.data, directories: null } : null;
  },

  parseOptions: () => null,

  /** One list of each tier, easiest first; the pool's picker prefers lists the seats have not been dealt lately. */
  async deal(pick) {
    const items = await pick(Object.fromEntries(TIERS.map((t) => [t, 1])));
    const lists = TIERS.map((tier) => items.find((item) => item.difficulty === tier)).flatMap((item) => {
      const parsed = item ? tenableListSchema.safeParse(item.payload) : null;
      return parsed?.success ? [{ id: item!.item_id, list: parsed.data }] : [];
    });
    if (lists.length !== LISTS) return null;
    // Loaded here, before the match exists and outside any lock: hydrating under the match lock then never waits on a
    // cold load (other replicas warm at boot). A list whose names cannot be loaded is not dealt.
    const ready = await Promise.all(lists.map((l) => tenableDirectories.get(l.list.kind, l.list.release).then(() => true, () => false)));
    if (ready.includes(false)) return null;
    return { itemIds: lists.map((l) => l.id), content: { lists: lists.map((l) => l.list), seed: randomInt(0, 0x100000000) } };
  },

  async hydrate(content) {
    if (content.directories) return content;
    const directories = await Promise.all(content.pack.lists.map((list) => tenableDirectories.get(list.kind, list.release)));
    return { pack: content.pack, directories };
  },

  start: (seats, content, nowMs) => startMatch(seats, content, nowMs),
  tick: (state, _content, nowMs) => tick(state, nowMs),
  afterOutage: (state, _content, nowMs) => afterOutage(state, nowMs),
  seatsChanged: (state, changes, nowMs) => seatsChanged(state, changes, nowMs),
  apply: (state, content, seat, command, nowMs) => applyCommand(state, content, seat, command, nowMs),
  terminal: (state) => (state.phase === 'over' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : null),
  standings: (state) => standings(state),
  view: (state, content, seat, locale) => viewOf(state, content, seat, (TENABLE_LOCALES as readonly string[]).includes(locale) ? locale as TenableLocale : 'en'),

  /**
   * A refused text is reportable only once its list is revealed (never as a way to test answers), and only when the
   * list would not accept it now. The subject is the list; the resolved id is who the text was read as.
   */
  refusal(state, content, round, text) {
    if (!Number.isInteger(round) || round < 0 || round >= LISTS || !listRevealed(state, round) || !content.directories || !normalizeTyped(text)) return null;
    const list = content.pack.lists[round];
    const directory = content.directories[round];
    const verdict = judge(directory, list.slots.map((s) => s.eid), new Set(), text);
    if (verdict.kind === 'right') return null;
    return { release: list.release, subject: list.id, resolvedPid: verdict.kind === 'wrong' ? verdict.eid : null };
  },
};
