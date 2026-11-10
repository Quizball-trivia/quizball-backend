import { randomInt } from 'node:crypto';
import { logger } from '../../../../core/logger.js';
import { normalizeTyped } from '../../../footballers/footballers.text.js';
import { TENABLE_LOCALES, tenableListSchema, type TenableLocale } from '../../../tenable/tenable.content.js';
import { tenableDirectories } from '../../../tenable/tenable.directories.js';
import { judge } from '../../../tenable/tenable.identify.js';
import { tenableGap } from '../../../tenable/tenable.gaps.js';
import type { RoomEngine } from '../../room.engine.js';
import {
  afterOutage, applyCommand, directoryOf, listRevealed, LISTS, seatsChanged, standings, startMatch, tenableCommandSchema, tenablePackSchema, tick, viewOf,
  type TenableCommand, type TenableContent, type TenableState,
} from './tenable.engine.js';

const TIERS = ['easy', 'medium', 'hard'] as const;

/** The pool tags a room must match: one per distinct supported interface language; null = no constraint. */
export function audienceTags(locales: readonly string[]): string[] | null {
  const known = [...new Set(locales.filter((l) => (TENABLE_LOCALES as readonly string[]).includes(l)))].sort();
  return known.length > 0 ? known.map((l) => `aud:${l}`) : null;
}

export const tenableRoomEngine: RoomEngine<TenableContent, TenableState, TenableCommand, null> = {
  game: 'tenable',
  version: 1,
  commandSchema: tenableCommandSchema,

  parseContent(raw) {
    const parsed = tenablePackSchema.safeParse(raw);
    return parsed.success ? { pack: parsed.data, directories: null } : null;
  },

  parseOptions: () => null,

  /**
   * One list of each tier, easiest first, for everyone in the room: a list for all, or for every language at the table
   * (a Spanish room is not dealt a Georgian or a Scottish list; a seat whose language is unknown allows only lists for
   * everyone). The pool's picker prefers lists the seats have not been
   * dealt lately. A tier with no list for this room falls back to any list, logged, so a match always starts.
   */
  async deal(pick, _options, _seats, ctx) {
    const audience = ctx?.unknownLocale ? ['aud:all'] : audienceTags(ctx?.locales ?? []);
    let items = await pick(Object.fromEntries(TIERS.map((t) => [t, 1])), undefined, { audience });
    const missing = TIERS.filter((tier) => !items.some((item) => item.difficulty === tier));
    if (audience && missing.length > 0) {
      logger.warn({ audience, missing }, 'Tenable room: no list for this room\'s languages; dealt one for any audience');
      items = [...items, ...(await pick(Object.fromEntries(missing.map((t) => [t, 1]))))];
    }
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

  /** The answer `seat` just gave as a content gap, judged against the list it was given on. */
  gaps(before, after, content, seat) {
    const last = after.last;
    if (!last || last === before.last || last.seat !== seat || last.kind === 'time') return [];
    const gap = tenableGap(last.kind, last.text, last.eid, content.pack.lists[before.list], directoryOf(content, before.list));
    return gap ? [gap] : [];
  },

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
