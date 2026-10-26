import { randomInt } from 'node:crypto';
import type { RoomEngine } from '../../room.engine.js';
import {
  afterOutage, applyCommand, conexionesCommandSchema, conexionesPackSchema, CX_MATCH_ORDER, seatsChanged, standings, startMatch, tick, viewOf,
  type ConexionesCommand, type ConexionesContent, type ConexionesState,
} from './conexiones.engine.js';
import { CX_DECOYS, cxBoardSchema, type CxBoard } from './conexiones.rules.js';

const shuffled = <T>(xs: readonly T[]): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

export const conexionesRoomEngine: RoomEngine<ConexionesContent, ConexionesState, ConexionesCommand, null> = {
  game: 'conexiones',
  version: 1,
  commandSchema: conexionesCommandSchema,

  parseContent(raw) {
    const parsed = conexionesPackSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },

  parseOptions(raw) {
    return raw === null || raw === undefined ? null : undefined;
  },

  /**
   * Five pool boards on the difficulty curve; each with its own tile order and naming-option order, and a random opener.
   * The pool hands twice the boards needed per difficulty, unseen first and then the ones the players met longest ago.
   * Of every way to fill the match from them, the one with the fewest footballers on two boards wins; then the fewest
   * boards met before, then the one whose most recently met board was met longest ago. A small pool may repeat a
   * footballer rather than not start.
   */
  async deal(pick) {
    const wanted: Record<string, number> = {};
    for (const d of CX_MATCH_ORDER) wanted[d] = (wanted[d] ?? 0) + 2;
    const byDifficulty = new Map<string, CxBoard[]>();
    const seenAt = new Map<string, number>();
    for (const item of await pick(wanted)) {
      const board = cxBoardSchema.safeParse(item.payload);
      if (!board.success || board.data.difficulty !== item.difficulty) continue;
      byDifficulty.set(item.difficulty, [...(byDifficulty.get(item.difficulty) ?? []), board.data]);
      if (item.seen_at) seenAt.set(board.data.id, new Date(item.seen_at).getTime());
    }
    const slots = new Map<string, number>();
    for (const d of CX_MATCH_ORDER) slots.set(d, (slots.get(d) ?? 0) + 1);
    // Per difficulty, every choice of its slot count among the candidates, as candidate indexes in list order.
    const choices = (n: number, of: number, from = 0): number[][] =>
      n === 0 ? [[]] : Array.from({ length: Math.max(0, of - from - n + 1) }, (_, k) => from + k).flatMap((i) => choices(n - 1, of, i + 1).map((rest) => [i, ...rest]));
    const difficulties = [...slots.keys()];
    const found: { cost: number[]; picked: Map<string, number[]> }[] = [];
    const walk = (at: number, picked: Map<string, number[]>) => {
      if (at === difficulties.length) {
        const boards = difficulties.flatMap((d) => picked.get(d)!.map((i) => byDifficulty.get(d)![i]));
        const players = boards.flatMap((b) => b.tiles.map((t) => t.player));
        const met = boards.map((b) => seenAt.get(b.id)).filter((t): t is number => t !== undefined);
        const cost = [players.length - new Set(players).size, met.length, Math.max(0, ...met), met.reduce((a, b) => a + b, 0)];
        const best = found[0];
        const differs = best ? cost.findIndex((c, i) => c !== best.cost[i]) : -1;
        if (!best || (differs >= 0 && cost[differs] < best.cost[differs])) found[0] = { cost, picked };
        return;
      }
      const d = difficulties[at];
      for (const c of choices(slots.get(d)!, byDifficulty.get(d)?.length ?? 0)) walk(at + 1, new Map(picked).set(d, c));
    };
    walk(0, new Map());
    if (!found[0]) return null;
    const chosen = found[0].picked;
    const next = new Map(difficulties.map((d) => [d, 0]));
    const boards = CX_MATCH_ORDER.map((d) => {
      const k = next.get(d)!;
      next.set(d, k + 1);
      return byDifficulty.get(d)![chosen.get(d)![k]];
    });
    const content: ConexionesContent = {
      first: randomInt(0, 2) as 0 | 1,
      boards: boards.map((board) => ({
        board,
        order: shuffled(board.tiles.map((t) => t.id)),
        options: shuffled([...Array(CX_DECOYS + 1).keys()]),
      })),
    };
    return { itemIds: content.boards.map((b) => b.board.id), content };
  },

  start: (seats, content, nowMs) => startMatch(seats, content, nowMs),
  tick: (state, content, nowMs) => tick(state, content, nowMs),
  afterOutage: (state, _content, nowMs) => afterOutage(state, nowMs),
  seatsChanged: (state, changes) => seatsChanged(state, changes),
  apply: (state, content, seat, command, nowMs) => applyCommand(state, content, seat, command, nowMs),
  terminal: (state) => (state.phase === 'over' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : null),
  standings: (state) => standings(state),
  view: (state, content, seat, locale) => viewOf(state, content, seat, locale),
};
