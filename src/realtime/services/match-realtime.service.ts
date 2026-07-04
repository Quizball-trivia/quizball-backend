/**
 * Match-realtime service — assembly shell.
 *
 * The actual implementation lives in sibling files, each owning a
 * single concern. This file's only job is to expose the unchanged
 * public surface (`matchRealtimeService` + `beginMatchForLobby`) so
 * external consumers don't need to know the layout:
 *
 *   - match-lifecycle.service.ts        match start + rejoin-on-connect
 *   - match-disconnect.service.ts       leave / pause / grace / resume
 *   - match-final-results.service.ts    payload assembly + replay + ack
 *   - match-forfeit.service.ts          finalize + socket adapter + pending
 *   - match-rematch.service.ts          friendly play-again lobby
 *   - match-question-dispatch.service.ts answer/countdown/clues/etc. routers
 *   - match-participants.helpers.ts     shared snapshot/profile lookups
 */
import {
  beginMatchForLobby,
  handleKickoffUiReady,
  rejoinActiveMatchOnConnect,
} from './match-lifecycle.service.js';
import {
  emitPendingForfeitIfAny,
  handleMatchForfeit,
} from './match-forfeit.service.js';
import { emitPendingPartyDropoutIfAny } from './party-quiz-dropout.service.js';
import {
  handleAnswer,
  handleCluesAnswer,
  handleCountdownGuess,
  handleHalftimeBan,
  handlePutInOrderAnswer,
  handleQuestionRevealed,
  handleReadyForNextQuestion,
} from './match-question-dispatch.service.js';
import {
  emitLastMatchResultIfAny,
  handleFinalResultsAck,
} from './match-final-results.service.js';
import { handlePlayAgain } from './match-rematch.service.js';
import {
  handleMatchDisconnect,
  handleMatchLeave,
  handleMatchRejoin,
  handleResumeUiReady,
  pauseMatchForDisconnectedPlayer,
  resumePausedMatch,
} from './match-disconnect.service.js';

export { beginMatchForLobby };

export const matchRealtimeService = {
  rejoinActiveMatchOnConnect,
  handleKickoffUiReady,
  handleMatchLeave,
  handleMatchForfeit,
  handleMatchRejoin,
  emitLastMatchResultIfAny,
  emitPendingForfeitIfAny,
  emitPendingPartyDropoutIfAny,
  handlePlayAgain,
  handleFinalResultsAck,
  resumePausedMatch,
  handleResumeUiReady,
  handleMatchDisconnect,
  pauseMatchForDisconnectedPlayer,
  handleHalftimeBan,
  handleAnswer,
  handleCountdownGuess,
  handlePutInOrderAnswer,
  handleCluesAnswer,
  handleReadyForNextQuestion,
  handleQuestionRevealed,
};
