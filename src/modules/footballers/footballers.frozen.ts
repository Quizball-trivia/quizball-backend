import { heldGreekIndex } from './footballers.greek.js';
import { RoomContentUnavailable } from './footballers.overlay.js';
import { heldRussianIndex } from './footballers.russian.js';
import type { Universe } from './footballers.universe.js';

/**
 * Under the match lock a room can only use overlay names this process holds: refused (retryable) before anything else
 * is read, so a room missing them never loads its release under the lock only to be refused afterwards.
 */
export function refuseMissingOverlays(state: { ov?: string; oe?: string } | null, content: { russian?: Universe | null; greek?: Universe | null }, underLock: boolean): void {
  if (!underLock || !state) return;
  if (state.ov && !content.russian && !heldRussianIndex(state.ov)) throw new RoomContentUnavailable();
  if (state.oe && !content.greek && !heldGreekIndex(state.oe)) throw new RoomContentUnavailable();
}
