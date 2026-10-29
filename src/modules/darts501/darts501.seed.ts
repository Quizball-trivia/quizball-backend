import { finishWithin, type D501Category } from './darts501.content.js';
import { D501 } from './darts501.rules.js';

/** Categories sharing this many footballer-and-number pairs give each other's answers away. */
export const SAME_PAIRS_MAX = 5;
/** A topic's family: the topic without its unit ("GB1:11:apps" → "GB1:11"). One family lives on one side only. */
export const familyOf = (topicKey: string) => topicKey.split(':').slice(0, 2).join(':');
export const keysOf = (c: Pick<D501Category, 'entries'>) => c.entries.map((e) => `${e.eid}=${e.value}`);

export type LedgerRow = { side: 'daily' | 'room'; category_id: string; topic_key: string; entry_keys: string[]; day: string | null };
export type Item = { category: D501Category; day: string | null };

/**
 * Why `item` (published on `side`) may not stand next to something already shown, or null. Across sides: the same topic
 * family, or SAME_PAIRS_MAX shared footballer-and-number pairs. Between dailies of different dates: the same category or
 * topic, or the same shared pairs (a closed day is public: its review, its practice runs). Rooms among themselves, and a
 * day's own earlier revisions, are free to overlap.
 */
export function conflict(side: 'daily' | 'room', item: Item, row: LedgerRow): string | null {
  const crossSide = row.side !== side;
  const otherDate = side === 'daily' && row.side === 'daily' && row.day !== item.day;
  if (!crossSide && !otherDate) return null;
  const c = item.category;
  if (crossSide && familyOf(row.topic_key) === familyOf(c.topicKey)) return `topic family ${familyOf(c.topicKey)} was shown on the ${row.side} side (${row.category_id})`;
  if (otherDate && (row.category_id === c.id || row.topic_key === c.topicKey)) return `${row.category_id} / ${row.topic_key} was already the daily on ${row.day}`;
  const keys = new Set(keysOf(c));
  const shared = row.entry_keys.filter((key) => keys.has(key)).length;
  return shared >= SAME_PAIRS_MAX ? `shows ${shared} of the same footballer-and-number pairs as ${row.category_id} (${row.side}${row.day ? ` ${row.day}` : ''})` : null;
}


/**
 * Pairs `item` shares with everything a player can already see from the other side or another day (the rows `conflict`
 * compares it with). Fewer than SAME_PAIRS_MAX per row can still add up to a whole checkout: refused when the shared
 * pairs alone check out from 501 within a run's darts.
 */
export function sharedFinish(side: 'daily' | 'room', item: Item, rows: readonly LedgerRow[]): string | null {
  const keys = new Set(keysOf(item.category));
  const shared = new Map<string, number>();
  for (const row of rows) {
    const relevant = row.side !== side || (side === 'daily' && row.side === 'daily' && row.day !== item.day);
    if (!relevant) continue;
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
