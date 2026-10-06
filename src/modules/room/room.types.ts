import { z } from 'zod';

export const ROOM_GAMES = ['aproximado'] as const;
export type RoomGameId = (typeof ROOM_GAMES)[number];
export const isRoomGame = (value: unknown): value is RoomGameId => ROOM_GAMES.includes(value as RoomGameId);

export const ROOM_LOCALES = ['es', 'en', 'ka', 'tr'] as const;
export type RoomLocale = (typeof ROOM_LOCALES)[number];
export const asRoomLocale = (value: unknown): RoomLocale | undefined =>
  (ROOM_LOCALES as readonly string[]).includes(value as string) ? (value as RoomLocale) : undefined;

export type RoomStatus = 'ready' | 'active' | 'completed' | 'cancelled';
export const LIVE_ROOM_STATUSES: readonly RoomStatus[] = ['ready', 'active'];

export interface RoomStanding { seat: number; userId: string; points: number; roundWins: number; place: number; withdrawn: boolean }
export interface RoomResult { reason: 'score' | 'cancelled'; standings: RoomStanding[] }

const localized = z.object({ es: z.string().min(1).max(200), en: z.string().min(1).max(200), ka: z.string().min(1).max(200), tr: z.string().min(1).max(200) }).strict();

/** One private pool question. The value and the exact window never reach a client before that question's reveal. */
export const aproximadoItemSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['fee', 'value', 'goals', 'attendance', 'height', 'apps', 'age']),
  prompt: localized,
  unit: localized,
  precision: z.number().int().min(0).max(3),
  exactWithin: z.number().min(0).max(100_000),
  value: z.number().min(0).max(10_000_000),
  source: z.record(z.unknown()).optional(),
}).strict();
export type AproximadoItem = z.infer<typeof aproximadoItemSchema>;

export const aproximadoContentSchema = z.object({ questions: z.array(aproximadoItemSchema).length(10) }).strict();
export type AproximadoContent = z.infer<typeof aproximadoContentSchema>;

export const roomCommandSchema = z.object({
  type: z.literal('guess'),
  round: z.number().int().min(0).max(50),
  value: z.number().finite(),
}).strict();
export type RoomCommand = z.infer<typeof roomCommandSchema>;

export class RoomError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}
