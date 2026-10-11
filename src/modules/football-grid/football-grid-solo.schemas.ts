import { z } from 'zod';
import { FOOTBALL_GRID_THEMES } from '../../realtime/schemas/football-grid.schemas.js';

const boardId = z.string().uuid();
const ticket = z.string().min(20).max(120);
const cellIndex = z.number().int().min(0).max(8);
// Nine cells, plus footballers replaced by a steal and those a same-phone opponent ruled out.
const usedPlayerIds = z.array(z.string().uuid()).max(24).default([]);
const optionSeed = z.string().regex(/^[a-z0-9-]{1,40}$/i);

export const footballGridSoloBoardSchema = z.object({
  theme: z.enum(FOOTBALL_GRID_THEMES).default('european'),
  difficulty: z.enum(['mixed', 'easy', 'normal', 'hard']).default('mixed'),
  excludeBoardIds: z.array(boardId).max(20).default([]),
});

export const footballGridSoloAnswerSchema = z.object({
  boardId,
  ticket,
  cellIndex,
  text: z.string().trim().min(1).max(160),
  usedPlayerIds,
  optionPlayerId: z.string().uuid().optional(),
});

export const footballGridSoloOptionsSchema = z.object({ boardId, ticket, cellIndex, usedPlayerIds, optionSeed });

export type FootballGridSoloBoardInput = z.infer<typeof footballGridSoloBoardSchema>;
export type FootballGridSoloAnswerInput = z.infer<typeof footballGridSoloAnswerSchema>;
export type FootballGridSoloOptionsInput = z.infer<typeof footballGridSoloOptionsSchema>;
