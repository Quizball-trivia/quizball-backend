/**
 * Lobby-realtime service — assembly shell.
 *
 * The actual implementation lives in sibling files, each owning a
 * single concern. This file's only job is to expose the unchanged
 * public surface (`lobbyRealtimeService` + `startDraft` +
 * `startRankedAiForUser`) so external consumers don't need to know
 * the layout:
 *
 *   - lobby-lifecycle.helpers.ts        shared low-level helpers (sink)
 *   - lobby-draft-start.service.ts      startDraft + per-lobby guards
 *   - lobby-ranked-ai.service.ts        ranked AI search / match-found / draft
 *   - lobby-commands.service.ts         createLobby / joinByCode / setReady /
 *                                       updateSettings / startFriendlyMatch /
 *                                       leaveLobby
 *   - lobby-challenge.service.ts        friend-challenge invite flow
 *   - lobby-connect.service.ts          rejoin / disconnect handlers
 *
 * Re-exports below keep cycle partner `draft-realtime.service.ts`
 * (which statically imports `startDraft`) and ranked-matchmaking
 * resolving against this shell exactly as before — no rewiring of
 * any caller, handler, or test mock.
 */
export { startDraft } from './lobby-draft-start.service.js';
export { startRankedAiForUser } from './lobby-ranked-ai.service.js';

import {
  rejoinWaitingLobbyOnConnect,
  rejoinActiveDraftLobbyOnConnect,
  handleLobbyDisconnect,
} from './lobby-connect.service.js';
import {
  emitPendingChallengeInvitesOnConnect,
  challengeFriend,
  acceptChallenge,
  declineChallenge,
} from './lobby-challenge.service.js';
import {
  createLobby,
  joinByCode,
  setReady,
  updateSettings,
  startFriendlyMatch,
  leaveLobby,
} from './lobby-commands.service.js';

export const lobbyRealtimeService = {
  rejoinWaitingLobbyOnConnect,
  rejoinActiveDraftLobbyOnConnect,
  emitPendingChallengeInvitesOnConnect,
  challengeFriend,
  acceptChallenge,
  declineChallenge,
  createLobby,
  joinByCode,
  setReady,
  updateSettings,
  startFriendlyMatch,
  leaveLobby,
  handleLobbyDisconnect,
};
