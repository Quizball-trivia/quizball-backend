import { config } from '../../core/config.js';
import { DUEL_GAMES, type DuelGameId } from './duel.types.js';

export const isDuelGame = (value: unknown): value is DuelGameId => DUEL_GAMES.includes(value as DuelGameId);

/** Per-game kill switch: DUEL_GAMES_ENABLED. */
export const anyDuelGameEnabled = (): boolean => config.DUEL_GAMES_ENABLED.length > 0;

export const isDuelGameEnabled = (game: unknown): game is DuelGameId => isDuelGame(game) && config.DUEL_GAMES_ENABLED.includes(game);
