import { pickOrder } from '../../src/modules/draft/draft.rules.js';
import type { DraftRoomState } from '../../src/modules/room/games/draft/draft.room.js';

export const activeSeatOf = (s: DraftRoomState): number => pickOrder(s.round + s.firstSeat, s.seats)[s.turn];
