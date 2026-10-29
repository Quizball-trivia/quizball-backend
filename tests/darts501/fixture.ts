import { buildDirectory, TENABLE_MATCHER_VERSION, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';
import type { D501Category } from '../../src/modules/darts501/darts501.content.js';
import { entriesOf, type Board } from '../../src/modules/darts501/darts501.rules.js';

// Invented footballers only: the repository is public.
export const PLAYERS: Array<[string, number | null]> = [
  ['Aro Bandel', 180], ['Ceto Darrin', 141], ['Emil Fosk', 100], ['Gian Holt', 60], ['Ivo Jarrel', 20],
  ['Kemi Lund', 200], ['Milo Narr', 163], ['Odo Prenn', 1], ['Quin Rask', 180], ['Sami Tull', 5],
  // In the release and covered, not in the category: a miss.
  ['Udo Varn', null],
  // In the release, not covered: free.
  ['Wim Xell', null],
  // Two holders of one surname, equally known: "Zorr" alone is ambiguous.
  ['Yan Zorr', 50], ['Bo Zorr', null],
  // Ones, to burn darts in tests without checking out.
  ...Array.from({ length: 24 }, (_, i): [string, number] => [`Pad ${String.fromCharCode(65 + i)}${String.fromCharCode(97 + i)}rrow`, 1]),
];
/** The k-th one-point footballer's name. */
export const pad = (k: number): string => PLAYERS[14 + k][0];
export const UNCOVERED = 'p11';
const rows: TenableEntity[] = PLAYERS.map(([name], i) => ({ eid: `p${i}`, name, known: name.split(' ')[1], fame: i === 12 || i === 13 ? 30 : Math.max(1, 90 - i), aliases: [], qualifier: null }));
export const directory = buildDirectory('player', 'rel', rows);
export const coverage: ReadonlySet<string> = new Set(rows.map((r) => r.eid).filter((eid) => eid !== UNCOVERED));

const localized = (text: string) => ({ es: text, en: text, ka: text, tr: text, ru: text, pt: text, de: text });

export function category(id = 'cat', tier: D501Category['tier'] = 'easy'): D501Category {
  return {
    id, kind: 'player', release: 'rel', matcher: TENABLE_MATCHER_VERSION, coverage: 'cov', tier, topicKey: id,
    title: localized(`Invented League apps for ${id}`), note: null, unit: 'apps', asOf: '2024-25',
    entries: PLAYERS.flatMap(([, value], i) => (value === null ? [] : [{ eid: `p${i}`, value }])),
  };
}

export const boardFor = (c: D501Category): Board => ({ directory, coverage, entries: entriesOf(c) });
