import { z } from 'zod';

export const ROOM_GAMES = ['aproximado', 'shared_player', 'name_chain', 'tenable', 'football_race', 'codenames', 'dato_falso'] as const;
export type RoomGameId = (typeof ROOM_GAMES)[number];
/** Seats of a room game without its own cap (the runtime holds up to eight; only Football Codenames uses them). */
export const ROOM_GAME_DEFAULT_SEATS = 6;
/** Room games with their own seat cap (Football Horserace: past four the race stops being fair; Football Codenames: two teams of four). */
export const ROOM_GAME_MAX_SEATS: Readonly<Partial<Record<RoomGameId, number>>> = { football_race: 4, codenames: 8 };
/** Seats a room of this game may hold: its own cap (six by default), never more than `ceiling`. */
export const roomGameSeats = (game: unknown, ceiling: number): number =>
  Math.min(ceiling, (typeof game === 'string' ? ROOM_GAME_MAX_SEATS[game as RoomGameId] : undefined) ?? ROOM_GAME_DEFAULT_SEATS);
/** Questions per difficulty in one match: the pool needs at least this many of each. */
export const ROOM_PACK_WANTED = { easy: 3, medium: 4, hard: 3 } as const;
export const isRoomGame = (value: unknown): value is RoomGameId => ROOM_GAMES.includes(value as RoomGameId);

export const ROOM_LOCALES = ['es', 'en', 'ka', 'tr', 'ru'] as const;
export type RoomLocale = (typeof ROOM_LOCALES)[number];
export const asRoomLocale = (value: unknown): RoomLocale | undefined =>
  (ROOM_LOCALES as readonly string[]).includes(value as string) ? (value as RoomLocale) : undefined;

export type RoomStatus = 'ready' | 'active' | 'completed' | 'cancelled';
export const LIVE_ROOM_STATUSES: readonly RoomStatus[] = ['ready', 'active'];

export interface RoomStanding { seat: number; userId: string; points: number; roundWins: number; place: number; withdrawn: boolean }
export interface RoomResult { reason: 'score' | 'cancelled'; standings: RoomStanding[] }

/** es/en/ka/tr are required; ru is optional until every pool item carries it. */
const localized = z.object({ es: z.string().min(1).max(200), en: z.string().min(1).max(200), ka: z.string().min(1).max(200), tr: z.string().min(1).max(200), ru: z.string().min(1).max(200).optional() }).strict();
export type RoomLocalizedText = z.infer<typeof localized>;
export const roomText = (value: RoomLocalizedText, locale: RoomLocale): string => value[locale] ?? value.en;

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
