import { buscaminasDuelEngine } from './engines/buscaminas.engine.js';
import { pistasDuelEngine } from './engines/pistas.engine.js';
import { ultimoDuelEngine } from './engines/ultimo.engine.js';
import type { DuelEngine, DuelGameId } from './duel.types.js';

// Engines are looked up by (game, version): a match keeps the engine it started with across deploys.
type AnyEngine = DuelEngine<unknown, unknown, unknown>;

const ENGINES: Record<DuelGameId, Record<number, AnyEngine>> = {
  buscaminas: { [buscaminasDuelEngine.version]: buscaminasDuelEngine as unknown as AnyEngine },
  pistas: { [pistasDuelEngine.version]: pistasDuelEngine as unknown as AnyEngine },
  ultimo: { [ultimoDuelEngine.version]: ultimoDuelEngine as unknown as AnyEngine },
};

const CURRENT: Record<DuelGameId, AnyEngine> = {
  buscaminas: buscaminasDuelEngine as unknown as AnyEngine,
  pistas: pistasDuelEngine as unknown as AnyEngine,
  ultimo: ultimoDuelEngine as unknown as AnyEngine,
};

export const currentEngine = (game: DuelGameId): AnyEngine => CURRENT[game];

/** Null for a version this build does not have (the match is then cancelled as a no-contest). */
export const engineFor = (game: DuelGameId, version: number): AnyEngine | null => ENGINES[game]?.[version] ?? null;

export type { AnyEngine };
