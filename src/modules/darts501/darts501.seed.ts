import { D501_PAIR_CLASS, finishWithin, type D501Category, type D501Unit } from './darts501.content.js';
import { D501 } from './darts501.rules.js';

/** Categories sharing this many footballer-and-number pairs give each other's answers away (at least; see `pairsLimit`). */
export const SAME_PAIRS_MAX = 5;
/** Share of the smaller category's entries that may coincide (small numbers repeat by chance across unrelated stats). */
export const SAME_PAIRS_SHARE = 0.1;
/** Dailies on the same subject (the club or nation of "ES1:418:apps", "CL:418:apps", "NT:ESP:caps") stand this many days apart. */
export const SUBJECT_GAP_DAYS = 21;
/** The subject gap binds days from here on; earlier days were seeded before it and stay correctable. */
export const SUBJECT_GAP_FROM = '2026-12-15';
export const keysOf = (c: Pick<D501Category, 'entries'>) => c.entries.map((e) => `${e.eid}=${e.value}`);
/** Competitions whose three-letter subject is a national team, not a nationality filter. */
const NATIONAL_TEAMS: ReadonlySet<string> = new Set(['NT']);
/** Subjects that name a group of clubs; a new grouping is added here on purpose. */
const CLUB_GROUPS: ReadonlySet<string> = new Set(['all', 'big3']);
const CLUB_ID = /^\d+$/;
const NATION = /^[A-Z]{3}$/;

/** What a player recognises in a topic: its club or nation; a group board ("CL:all:goals", "IT1:big3:apps") is its competition's. */
export function subjectOf(topicKey: string): string | null {
  const [competition, subject] = topicKey.split(':');
  if (!subject) return null;
  return CLUB_GROUPS.has(subject) ? `${competition}:${subject}` : subject;
}
/**
 * Units of one family that show the same winners whatever the exact numbers: apps minus goals is apps shifted by each
 * footballer's goals, so its leaders are the apps leaders though not one pair need match.
 */
const DERIVED_UNITS: ReadonlySet<string> = new Set(['apps', 'apps_minus_goals']);
const familyOf = (topicKey: string) => topicKey.split(':').slice(0, 2).join(':');
const derivedTwins = (a: string, b: string) => {
  const [ua, ub] = [a.split(':')[2], b.split(':')[2]];
  return ua !== ub && DERIVED_UNITS.has(ua) && DERIVED_UNITS.has(ub) && familyOf(a) === familyOf(b);
};
/** Shared pairs that refuse two categories: SAME_PAIRS_MAX, or SAME_PAIRS_SHARE of the smaller one if that is more. */
export const pairsLimit = (a: number, b: number) => Math.max(SAME_PAIRS_MAX, Math.ceil(SAME_PAIRS_SHARE * Math.min(a, b)));
const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

export type LedgerRow = { side: 'daily' | 'room'; category_id: string; topic_key: string; entry_keys: string[]; day: string | null };
export type Item = { category: D501Category; day: string | null };

/**
 * Who a topic is about: one club (its numeric id), one national team ("NT:ESP"), or a combination of clubs: a
 * nationality ("CLN:BRA", "GB1:BRA"), a group ("IT1:big3") or a whole competition ("CL:all"). Null for any other shape.
 */
export function scopeOf(topicKey: string): 'club' | 'nation' | 'combined' | null {
  const [competition, subject] = topicKey.split(':');
  if (!competition || !subject) return null;
  if (CLUB_ID.test(subject)) return 'club';
  if (NATION.test(subject)) return NATIONAL_TEAMS.has(competition) ? 'nation' : 'combined';
  return CLUB_GROUPS.has(subject) ? 'combined' : null;
}
const pairClassOf = (topicKey: string) => {
  const unit = topicKey.split(':')[2];
  return unit && Object.hasOwn(D501_PAIR_CLASS, unit) ? D501_PAIR_CLASS[unit as D501Unit] : 'count';
};
/**
 * Whether two boards' footballer-and-number pairs can give each other away, read from their topics (stored rows carry
 * nothing else). Only within one unit class: a €45m value is not 45 apps. And a combined board repeats its single-club
 * members' numbers by construction (owner, 2026-11-23), so a combined board and a club board are not compared; every
 * other pairing (club and club, national teams, combined and combined) is, as before.
 */
export function pairsComparable(a: string, b: string): boolean {
  if (pairClassOf(a) !== pairClassOf(b)) return false;
  const scopes = [scopeOf(a), scopeOf(b)];
  return !(scopes.includes('club') && scopes.includes('combined'));
}

/**
 * The comparisons above read unit and scope from the topic, so new content must spell both there:
 * "<competition>:<club id, nation or group>:<its unit>", in a shape `scopeOf` knows.
 */
export function topicProblem(c: Pick<D501Category, 'topicKey' | 'unit'>): string | null {
  const parts = c.topicKey.split(':');
  if (parts.length !== 3 || !/^[A-Z][A-Z0-9]*$/.test(parts[0]) || scopeOf(c.topicKey) === null) return `topic ${c.topicKey} is not <competition>:<club id, nation or group>:<unit>`;
  return parts[2] === c.unit ? null : `topic ${c.topicKey} ends in ${parts[2]}, not its unit ${c.unit}`;
}

/**
 * Why `item` (published on `side`) may not stand next to something already shown, or null. Across sides: the same topic,
 * its apps / apps-minus-goals twin, or `pairsLimit` shared footballer-and-number pairs (between boards `pairsComparable`). Between dailies of different dates: the same category or topic, the
 * twin, the same shared pairs (a closed day is public: its review, its practice runs), or the same subject within SUBJECT_GAP_DAYS
 * (for days from SUBJECT_GAP_FROM). Rooms among themselves, and a day's own earlier revisions, are free to overlap.
 */
export function conflict(side: 'daily' | 'room', item: Item, row: LedgerRow): string | null {
  const crossSide = row.side !== side;
  const otherDate = side === 'daily' && row.side === 'daily' && row.day !== item.day;
  if (!crossSide && !otherDate) return null;
  const c = item.category;
  if (crossSide && row.topic_key === c.topicKey) return `topic ${c.topicKey} was shown on the ${row.side} side (${row.category_id})`;
  if ((crossSide || otherDate) && derivedTwins(row.topic_key, c.topicKey)) return `${c.topicKey} shows the same leaders as ${row.topic_key} (${row.category_id}, ${row.side}${row.day ? ` ${row.day}` : ''})`;
  if (otherDate && (row.category_id === c.id || row.topic_key === c.topicKey)) return `${row.category_id} / ${row.topic_key} was already the daily on ${row.day}`;
  if (otherDate && item.day && row.day && item.day >= SUBJECT_GAP_FROM) {
    const subject = subjectOf(c.topicKey);
    const apart = daysApart(item.day, row.day);
    if (subject && subject === subjectOf(row.topic_key) && apart < SUBJECT_GAP_DAYS) return `subject ${subject} was the daily ${apart} day(s) away on ${row.day} (${row.category_id}); at least ${SUBJECT_GAP_DAYS} apart`;
  }
  if (!pairsComparable(c.topicKey, row.topic_key)) return null;
  const keys = new Set(keysOf(c));
  const shared = row.entry_keys.filter((key) => keys.has(key)).length;
  const limit = pairsLimit(keys.size, row.entry_keys.length);
  return shared >= limit ? `shows ${shared} of the same footballer-and-number pairs as ${row.category_id} (${row.side}${row.day ? ` ${row.day}` : ''}; limit ${limit})` : null;
}


/**
 * Pairs `item` shares with everything a player can already see from the other side or another day (the rows `conflict`
 * compares it with). Fewer than `pairsLimit` per row can still add up to a whole checkout: refused when the shared
 * pairs alone check out from 501 within a run's darts.
 */
export function sharedFinish(side: 'daily' | 'room', item: Item, rows: readonly LedgerRow[]): string | null {
  const keys = new Set(keysOf(item.category));
  const shared = new Map<string, number>();
  for (const row of rows) {
    const relevant = row.side !== side || (side === 'daily' && row.side === 'daily' && row.day !== item.day);
    if (!relevant || !pairsComparable(item.category.topicKey, row.topic_key)) continue;
    for (const key of row.entry_keys) {
      if (!keys.has(key)) continue;
      const at = key.lastIndexOf('=');
      shared.set(key.slice(0, at), Number(key.slice(at + 1)));
    }
  }
  if (shared.size === 0) return null;
  const entries = [...shared].map(([eid, value]) => ({ eid, value }));
  return finishWithin({ ...item.category, entries }, D501.darts) ? `${shared.size} footballer-and-number pairs it shares with published content check out on their own` : null;
}

/** A category as the exposure check sees it: where it is shown and its footballer=number pairs. */
export interface Exposed { id: string; side: 'daily' | 'room'; day: string | null; topicKey: string; keys: ReadonlySet<string> }

/**
 * Every category of the ledger as it would stand (`all`: stored rows and the incoming batch), checked as the one whose
 * answers could leak: the pairs it shares with the other side and with dailies of other dates, together, must not check
 * out on their own. A new category can thus be refused for what it adds to an existing one's exposure. Returns why, or null.
 */
export function exposedCheckout(all: readonly Exposed[]): string | null {
  for (const victim of all) {
    const shared = new Map<string, number>();
    for (const other of all) {
      if (other === victim) continue;
      const relevant = other.side !== victim.side || (victim.side === 'daily' && other.side === 'daily' && other.day !== victim.day);
      if (!relevant || !pairsComparable(victim.topicKey, other.topicKey)) continue;
      const [small, big] = other.keys.size < victim.keys.size ? [other.keys, victim.keys] : [victim.keys, other.keys];
      for (const key of small) {
        if (!big.has(key)) continue;
        const at = key.lastIndexOf('=');
        shared.set(key.slice(0, at), Number(key.slice(at + 1)));
      }
    }
    if (shared.size === 0) continue;
    const entries = [...shared].map(([eid, value]) => ({ eid, value }));
    if (finishWithin({ entries } as unknown as D501Category, D501.darts)) return `${victim.id} (${victim.side}${victim.day ? ` ${victim.day}` : ''}): ${shared.size} of its footballer-and-number pairs shown elsewhere check out on their own`;
  }
  return null;
}

/**
 * Why a batch for `side` may not be published next to the ledger (`shown`), or null. Each incoming item is checked against
 * the ledger and the rest of the batch, then the exposure of everything together. A daily that is the day's live content
 * (`live`: day → its current revision) was checked when it went live: it is only compared against, so re-sending an
 * unchanged day next to a correction of an earlier one does not turn the subject gap around. A superseded revision being
 * restored is not live, and is checked like new content.
 */
export function batchRefusal(side: 'daily' | 'room', items: readonly Item[], shown: readonly LedgerRow[], revisionOf: (c: D501Category) => string, live: ReadonlyMap<string, string> = new Map()): string | null {
  const incoming: LedgerRow[] = items.map((it) => ({ side, category_id: it.category.id, topic_key: it.category.topicKey, entry_keys: keysOf(it.category), day: it.day }));
  for (const [i, item] of items.entries()) {
    if (side === 'daily' && item.day !== null && live.get(item.day) === revisionOf(item.category)) continue;
    const rows = [...shown, ...incoming.filter((_, j) => j !== i)];
    for (const row of rows) {
      const why = conflict(side, item, row);
      if (why) return `${item.category.id}: ${why}`;
    }
    const leak = sharedFinish(side, item, rows);
    if (leak) return `${item.category.id}: ${leak}`;
  }
  // What the batch adds to everything already shown: no existing category may end up exposed either.
  return exposedCheckout([...shown, ...incoming].map((r) => ({ id: r.category_id, side: r.side, day: r.day, topicKey: r.topic_key, keys: new Set(r.entry_keys) })));
}
