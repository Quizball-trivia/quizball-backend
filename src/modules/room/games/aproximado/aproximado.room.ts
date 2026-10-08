import type { RoomEngine } from '../../room.engine.js';
import { aproximadoContentSchema, ROOM_PACK_WANTED, roomCommandSchema, type AproximadoContent, type RoomCommand } from '../../room.types.js';
import { finalStandings, isIdle, seatsChanged, startMatch, submitGuess, tick, type EngineConfig, type EngineState } from './aproximado.engine.js';
import { ROUND_MS, ROUNDS } from './aproximado.rules.js';

const PACK_ORDER = ['easy', 'medium', 'easy', 'medium', 'hard', 'medium', 'easy', 'hard', 'medium', 'hard'] as const;

const engineConfig = (content: AproximadoContent, seats: number): EngineConfig => ({
  questions: content.questions.map((q) => ({ id: q.id, kind: q.kind, prompt: '', unit: '', precision: q.precision, exactWithin: q.exactWithin, value: q.value })),
  // A 1v1 is closest-takes-it (the videos' rule); three or more play the podium.
  scoring: seats === 2 ? 'closest' : 'podium',
  rounds: ROUNDS,
});

const configOf = (state: EngineState, content: AproximadoContent) => engineConfig(content, state.status.length);

export const aproximadoRoomEngine: RoomEngine<AproximadoContent, EngineState, RoomCommand> = {
  game: 'aproximado',
  version: 1,
  commandSchema: roomCommandSchema,

  parseContent(raw) {
    const parsed = aproximadoContentSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },

  // Aproximado has nothing to choose: whatever a room carries is ignored.
  parseOptions: () => null,

  async deal(pick) {
    const items = await pick(ROOM_PACK_WANTED);
    const byDifficulty = new Map<string, typeof items>();
    for (const item of items) byDifficulty.set(item.difficulty, [...(byDifficulty.get(item.difficulty) ?? []), item]);
    const dealt = PACK_ORDER.map((d) => byDifficulty.get(d)?.shift());
    if (dealt.some((item) => !item)) return null;
    return { itemIds: dealt.map((item) => item!.item_id), content: { questions: dealt.map((item) => item!.payload) } };
  },

  start: (seats, content, nowMs) => startMatch(seats, engineConfig(content, seats), nowMs),
  tick: (state, content, nowMs) => tick(state, configOf(state, content), nowMs),
  afterOutage: (state, _content, nowMs) => (state.phase === 'guess' ? { ...state, deadline: nowMs + ROUND_MS } : state),
  seatsChanged: (state, changes) => seatsChanged(state, changes),

  apply(state, content, seat, command, nowMs) {
    if (state.phase === 'guess' && state.round !== command.round) return { state, error: 'stale_round' };
    return submitGuess(state, configOf(state, content), seat, command.value, nowMs);
  },

  terminal: (state) => (state.phase === 'over' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : null),
  standings: (state) => finalStandings(state),

  view(state, content, seat, locale) {
    const table = finalStandings(state);
    const q = content.questions[state.round];
    const reveal = state.phase === 'reveal' ? state.results[state.results.length - 1] ?? null : null;
    return {
      phase: state.phase === 'cancelled' ? 'over' : state.phase,
      round: state.round,
      totalRounds: ROUNDS,
      scoring: state.status.length === 2 ? 'closest' : 'podium',
      question: { id: q.id, kind: q.kind, prompt: q.prompt[locale], unit: q.unit[locale], precision: q.precision },
      seats: state.status.map((status, s) => ({
        seat: s, status,
        answered: state.phase === 'guess' ? state.guesses[s] !== null : reveal ? reveal.entries[s]?.guess !== null : false,
        idle: isIdle(state, s), score: table.find((t) => t.seat === s)?.points ?? 0,
      })),
      mySeat: seat,
      myGuess: state.phase === 'guess' ? state.guesses[seat] : reveal ? reveal.entries[seat]?.guess ?? null : null,
      reveal,
      // Only revealed rounds: the open question's guesses are never in here.
      results: state.results,
      standings: state.phase === 'over' ? table : null,
      deadline: state.phase === 'over' || state.phase === 'cancelled' ? null : new Date(state.deadline).toISOString(),
    };
  },
};
