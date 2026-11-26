import { sql } from '../../db/index.js';
import { LAST_DAY as BUSCAMINAS_LAST, releaseDay } from '../buscaminas/buscaminas.days.js';
import { codenamesCalendar } from '../codenames/codenames.days.js';
import { conexionesCalendar } from '../conexiones/conexiones.days.js';
import { darts501Calendar } from '../darts501-daily/darts501-daily.days.js';
import { datoFalsoCalendar } from '../dato-falso/dato-falso.days.js';
import { draftCalendar } from '../draft/draft-daily.days.js';
import { footballRaceCalendar } from '../football-race/football-race.days.js';
import { gridDailyCalendar } from '../grid-daily/grid-daily.days.js';
import { minutoCalendar } from '../minuto/minuto.days.js';
import { nameChainCalendar } from '../name-chain-daily/name-chain-daily.days.js';
import { pistasCalendar } from '../pistas/pistas.days.js';
import { sharedPlayerCalendar } from '../shared-player-daily/shared-player-daily.days.js';
import { tenableCalendar } from '../tenable-daily/tenable-daily.days.js';
import { ultimoCalendar } from '../ultimo/ultimo.days.js';

// Runway: how many days of content each daily game has left. A game ends at
// the earlier of two things: its last stored day, and the last day its code
// allows (a fixed calendar ends there whatever is stored). The Content tab
// shows both, so a game never runs out unnoticed.

const OPEN = '9999-12-31';

/** Every daily game: its days table and the last day its calendar allows. Add a game here when it gets a days table. */
export const DAILY_GAMES: ReadonlyArray<{ key: string; label: string; table: string; lastAllowed: string }> = [
  { key: 'buscaminas', label: 'Minesweeper', table: 'buscaminas_days', lastAllowed: BUSCAMINAS_LAST },
  { key: 'codenames', label: 'Codenames', table: 'codenames_days', lastAllowed: codenamesCalendar.LAST_DAY },
  { key: 'conexiones', label: 'Conexiones', table: 'conexiones_days', lastAllowed: conexionesCalendar.LAST_DAY },
  { key: 'darts501', label: 'Darts 501', table: 'darts501_days', lastAllowed: darts501Calendar.LAST_DAY },
  { key: 'dato-falso', label: 'Dato Falso', table: 'dato_falso_days', lastAllowed: datoFalsoCalendar.LAST_DAY },
  { key: 'draft', label: 'Football Draft', table: 'draft_days', lastAllowed: draftCalendar.LAST_DAY },
  { key: 'football-race', label: 'Football Race', table: 'football_race_days', lastAllowed: footballRaceCalendar.LAST_DAY },
  { key: 'grid-daily', label: 'Tic Tac Toe daily', table: 'grid_daily_days', lastAllowed: gridDailyCalendar.LAST_DAY },
  { key: 'minuto', label: 'Minuto', table: 'minuto_days', lastAllowed: minutoCalendar.LAST_DAY },
  { key: 'name-chain', label: 'Name Chain', table: 'name_chain_days', lastAllowed: nameChainCalendar.LAST_DAY },
  { key: 'pistas', label: 'Pistas', table: 'pistas_days', lastAllowed: pistasCalendar.LAST_DAY },
  { key: 'shared-player', label: 'Shared Player', table: 'shared_player_days', lastAllowed: sharedPlayerCalendar.LAST_DAY },
  { key: 'tenable', label: 'Tenable', table: 'tenable_days', lastAllowed: tenableCalendar.LAST_DAY },
  { key: 'ultimo', label: 'Último', table: 'ultimo_days', lastAllowed: ultimoCalendar.LAST_DAY },
];

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export interface RunwayRow {
  key: string;
  label: string;
  /** End of the unbroken run of stored days from today (a missing day ends it); null when today has no board. */
  storedThrough: string | null;
  /** Last day the game's code allows; null = open-ended. */
  calendarEnds: string | null;
  /** The last day players get a new board: the earlier of the two. */
  endsOn: string | null;
  /** Days after today that still have a board. */
  daysLeft: number;
  /** What stops it first: 'content' (store more days) or 'calendar' (the fixed end in code must be lifted too). */
  limitedBy: 'content' | 'calendar' | 'both';
}

/** Pure: one runway row from what is stored and what the calendar allows. */
export function runwayRow(game: { key: string; label: string; lastAllowed: string }, storedThrough: string | null, today: string): RunwayRow {
  const calendarEnds = game.lastAllowed >= OPEN ? null : game.lastAllowed;
  const endsOn = storedThrough === null ? null : calendarEnds !== null && calendarEnds < storedThrough ? calendarEnds : storedThrough;
  const daysLeft = endsOn === null ? 0 : Math.max(0, daysBetween(today, endsOn));
  const limitedBy = calendarEnds === null || storedThrough === null ? 'content' : calendarEnds === storedThrough ? 'both' : calendarEnds < storedThrough ? 'calendar' : 'content';
  return { key: game.key, label: game.label, storedThrough, calendarEnds, endsOn, daysLeft, limitedBy };
}

export async function dailyRunway(now: Date = new Date()): Promise<RunwayRow[]> {
  const today = releaseDay(now);
  const present = new Set(
    (await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY(${DAILY_GAMES.map((g) => g.table)})`).map((r) => r.table_name),
  );
  const games = DAILY_GAMES.filter((g) => present.has(g.table));
  const covered = new Map<string, string | null>();
  if (games.length > 0) {
    // One statement for every game (table names come from the fixed list above, never from input). Per game:
    // the end of the unbroken run of stored days starting today, so a missing day ends the runway there
    // even when later days are stored.
    const parts = games.map(
      (g) => `SELECT '${g.key}' AS key, (SELECT max(day)::text FROM (SELECT day, row_number() OVER (ORDER BY day) AS rn FROM public.${g.table} WHERE day >= $1::date) d WHERE day = $1::date + (rn - 1)::int) AS last`,
    );
    for (const r of await sql.unsafe<Array<{ key: string; last: string | null }>>(parts.join(' UNION ALL '), [today])) covered.set(r.key, r.last);
  }
  return DAILY_GAMES.map((g) => runwayRow(g, covered.get(g.key) ?? null, today)).sort((a, b) => a.daysLeft - b.daysLeft || a.label.localeCompare(b.label));
}
