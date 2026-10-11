import { z } from 'zod';
import type {
  FootballGridDifficulty,
  FootballGridSeriesFormat,
  FootballGridSettings,
} from './football-grid.types.js';

export const FOOTBALL_GRID_DEFAULT_TURN_MS = 40_000;
export const FOOTBALL_GRID_TURN_SECONDS = [20, 40, 60] as const;
/** Finished games during which a player is a newcomer: easy boards, an easier bot, four answers to pick from. */
export const FOOTBALL_GRID_STARTER_GAMES = 3;
/** Newcomers are dealt boards scoring at least this share of right answers while any are left unseen. */
export const FOOTBALL_GRID_STARTER_MIN_SCORE = 0.7;

export const DEFAULT_FOOTBALL_GRID_SETTINGS: FootballGridSettings = Object.freeze({
  turnMs: FOOTBALL_GRID_DEFAULT_TURN_MS,
  answerMode: 'type',
  boardDifficulty: null,
});

const storedSettingsSchema = z.object({
  turnSeconds: z.number().int().min(10).max(120).optional(),
  answerMode: z.enum(['type', 'choice']).optional(),
  boardDifficulty: z.enum(['easy', 'normal', 'hard']).nullable().optional(),
});

/** Reads the `settings` column of a series or match. Anything missing or malformed plays as the standard game. */
export function parseFootballGridSettings(raw: unknown): FootballGridSettings {
  const parsed = storedSettingsSchema.safeParse(raw ?? {});
  if (!parsed.success) return DEFAULT_FOOTBALL_GRID_SETTINGS;
  return {
    turnMs: parsed.data.turnSeconds ? parsed.data.turnSeconds * 1_000 : FOOTBALL_GRID_DEFAULT_TURN_MS,
    answerMode: parsed.data.answerMode ?? 'type',
    boardDifficulty: parsed.data.boardDifficulty ?? null,
  };
}

/** The stored form; null for the standard game, so untouched rows and default rooms look the same. */
export function storedFootballGridSettings(settings: FootballGridSettings): Record<string, unknown> | null {
  const stored: Record<string, unknown> = {};
  if (settings.turnMs !== FOOTBALL_GRID_DEFAULT_TURN_MS) stored.turnSeconds = Math.round(settings.turnMs / 1_000);
  if (settings.answerMode !== 'type') stored.answerMode = settings.answerMode;
  if (settings.boardDifficulty) stored.boardDifficulty = settings.boardDifficulty;
  return Object.keys(stored).length > 0 ? stored : null;
}

const BOT_LADDER_START_RP = 450;
const BOT_LADDER_STEP_RP = 350;
const BOT_LADDER_MIN_RP = 300;
const BOT_LADDER_MAX_RP = 2700;
const BOT_LADDER_GAMES = 10;

/**
 * The RP a Tic Tac Toe bot is picked by. Quiz ranking says nothing about a player's first games here, and a
 * player without a ranked placement has none: they start against a Youth Prospect bot and move one step per net
 * win over their last ten games. A placed player joins their ranked level once they have played ten.
 */
export function footballGridBotTargetRp(input: {
  rankedTargetRp: number;
  placed: boolean;
  experience: { finished: number; wins: number; losses: number };
}): number {
  const ladder = Math.min(BOT_LADDER_MAX_RP, Math.max(
    BOT_LADDER_MIN_RP,
    BOT_LADDER_START_RP + BOT_LADDER_STEP_RP * (input.experience.wins - input.experience.losses),
  ));
  if (!input.placed) return ladder;
  return input.experience.finished < BOT_LADDER_GAMES ? Math.min(input.rankedTargetRp, ladder) : input.rankedTargetRp;
}

export function footballGridSeriesTargetWins(format: FootballGridSeriesFormat): number {
  if (format === 'bo7') return 4;
  if (format === 'bo5') return 3;
  return format === 'bo3' ? 2 : 1;
}

export function footballGridSeriesMaxGames(format: FootballGridSeriesFormat): number {
  if (format === 'bo7') return 7;
  if (format === 'bo5') return 5;
  return format === 'bo3' ? 3 : 1;
}

/** What a friend room's host may set, as kept in `lobbies.room_options`. */
export const footballGridRoomOptionsSchema = z.object({
  rounds: z.enum(['bo3', 'bo5', 'bo7']).default('bo3'),
  turnSeconds: z.union([z.literal(20), z.literal(40), z.literal(60)]).default(40),
  answers: z.enum(['type', 'choice']).default('type'),
  difficulty: z.enum(['mixed', 'easy', 'normal', 'hard']).default('mixed'),
}).strict();

export type FootballGridRoomOptions = z.infer<typeof footballGridRoomOptionsSchema>;

export function footballGridRoomRules(raw: unknown): {
  options: FootballGridRoomOptions;
  format: FootballGridSeriesFormat;
  settings: FootballGridSettings;
} {
  const parsed = footballGridRoomOptionsSchema.safeParse(raw ?? {});
  const options = parsed.success ? parsed.data : footballGridRoomOptionsSchema.parse({});
  return {
    options,
    format: options.rounds,
    settings: {
      turnMs: options.turnSeconds * 1_000,
      answerMode: options.answers,
      boardDifficulty: options.difficulty === 'mixed' ? null : options.difficulty as FootballGridDifficulty,
    },
  };
}
