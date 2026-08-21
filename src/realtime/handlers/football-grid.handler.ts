import { logger } from '../../core/logger.js';
import {
  footballGridReportMissingAnswerSchema,
  footballGridCompletedAckSchema,
  footballGridSearchCancelSchema,
  footballGridRematchAcceptSchema,
  footballGridRematchDeclineSchema,
  footballGridResyncSchema,
  footballGridSearchStartSchema,
  footballGridSubmitAnswerSchema,
  footballGridVersionedCommandSchema,
} from '../schemas/football-grid.schemas.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { footballGridMatchmakingService } from '../services/football-grid-matchmaking.service.js';
import { footballGridRealtimeService } from '../services/football-grid-realtime.service.js';
import { footballGridRematchService } from '../services/football-grid-rematch.service.js';
import { allowFootballGridOperation } from '../services/football-grid-rate-limit.service.js';

function invalid(socket: QuizballSocket, event: string, details: unknown): void {
  logger.warn({ event, details, userId: socket.data.user.id }, 'Invalid Football Grid payload');
  socket.emit('grid:error', { code: 'VALIDATION_ERROR', message: 'Invalid Football Tic Tac Toe request' });
}

function run(
  socket: QuizballSocket,
  event: string,
  operation: () => Promise<void>,
): void {
  void operation().catch((error) => {
    logger.error({ error, event, userId: socket.data.user.id }, 'Football Grid socket handler failed');
    footballGridRealtimeService.emitError(socket, error);
  });
}

function runLimited(
  socket: QuizballSocket,
  event: string,
  operation: Parameters<typeof allowFootballGridOperation>[1],
  task: () => Promise<void>,
): void {
  run(socket, event, async () => {
    if (!await allowFootballGridOperation(socket.data.user.id, operation)) {
      socket.emit('grid:error', { code: 'GRID_RATE_LIMITED', message: 'Too many Tic Tac Toe requests. Please slow down.' });
      return;
    }
    await task();
  });
}

export function registerFootballGridHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('grid:search_start', (payload) => {
    const parsed = footballGridSearchStartSchema.safeParse(payload);
    if (!parsed.success) return invalid(socket, 'grid:search_start', parsed.error.flatten());
    runLimited(socket, 'grid:search_start', 'search', () => footballGridMatchmakingService.handleSearchStart(io, socket, parsed.data));
  });
  socket.on('grid:search_cancel', (payload) => {
    const parsed = footballGridSearchCancelSchema.safeParse(payload);
    if (!parsed.success) return invalid(socket, 'grid:search_cancel', parsed.error.flatten());
    runLimited(socket, 'grid:search_cancel', 'search', () => (
      footballGridMatchmakingService.handleSearchCancel(io, socket, parsed.data.searchId)
    ));
  });
  socket.on('grid:match_found_ack', (payload) => {
    const parsed = footballGridVersionedCommandSchema.safeParse(payload);
    if (!parsed.success) return invalid(socket, 'grid:match_found_ack', parsed.error.flatten());
    runLimited(socket, 'grid:match_found_ack', 'command', () => footballGridRealtimeService.handleHandoffAck(io, socket, parsed.data));
  });
  socket.on('grid:client_ready', (payload) => {
    const parsed = footballGridVersionedCommandSchema.safeParse(payload);
    if (!parsed.success) return invalid(socket, 'grid:client_ready', parsed.error.flatten());
    runLimited(socket, 'grid:client_ready', 'command', () => footballGridRealtimeService.handleReady(io, socket, parsed.data));
  });
  socket.on('grid:submit_answer', (payload) => {
    const parsed = footballGridSubmitAnswerSchema.safeParse(payload);
    if (!parsed.success) return invalid(socket, 'grid:submit_answer', parsed.error.flatten());
    runLimited(socket, 'grid:submit_answer', 'command', () => footballGridRealtimeService.handleAnswer(io, socket, parsed.data));
  });
  socket.on('grid:pass', (payload) => {
    const parsed = footballGridVersionedCommandSchema.safeParse(payload);
    if (!parsed.success) return invalid(socket, 'grid:pass', parsed.error.flatten());
    runLimited(socket, 'grid:pass', 'command', () => footballGridRealtimeService.handlePass(io, socket, parsed.data));
  });
  socket.on('grid:resync', (payload) => {
    const parsed = footballGridResyncSchema.safeParse(payload);
    if (!parsed.success) return invalid(socket, 'grid:resync', parsed.error.flatten());
    runLimited(socket, 'grid:resync', 'resync', () => footballGridRealtimeService.handleResync(io, socket, parsed.data.matchId));
  });
  socket.on('grid:completed_ack', (payload) => {
    const parsed = footballGridCompletedAckSchema.safeParse(payload);
    if (!parsed.success) return invalid(socket, 'grid:completed_ack', parsed.error.flatten());
    runLimited(socket, 'grid:completed_ack', 'command', () => (
      footballGridRealtimeService.handleCompletedAck(socket, parsed.data)
    ));
  });
  socket.on('grid:forfeit', (payload) => {
    const parsed = footballGridVersionedCommandSchema.safeParse(payload);
    if (!parsed.success) return invalid(socket, 'grid:forfeit', parsed.error.flatten());
    runLimited(socket, 'grid:forfeit', 'command', () => footballGridRealtimeService.handleForfeit(io, socket, parsed.data));
  });
  socket.on('grid:report_missing_answer', (payload) => {
    const parsed = footballGridReportMissingAnswerSchema.safeParse(payload);
    if (!parsed.success) return invalid(socket, 'grid:report_missing_answer', parsed.error.flatten());
    runLimited(socket, 'grid:report_missing_answer', 'report', () => footballGridRealtimeService.handleReport(socket, parsed.data.attemptId));
  });
  socket.on('grid:rematch_accept', (payload) => {
    const parsed = footballGridRematchAcceptSchema.safeParse(payload);
    if (!parsed.success) return invalid(socket, 'grid:rematch_accept', parsed.error.flatten());
    runLimited(socket, 'grid:rematch_accept', 'rematch', () => footballGridRematchService.accept(io, socket, parsed.data));
  });
  socket.on('grid:rematch_decline', (payload) => {
    const parsed = footballGridRematchDeclineSchema.safeParse(payload);
    if (!parsed.success) return invalid(socket, 'grid:rematch_decline', parsed.error.flatten());
    runLimited(socket, 'grid:rematch_decline', 'rematch', () => footballGridRematchService.decline(io, socket, parsed.data));
  });
  socket.on('grid:presence_heartbeat', (payload) => {
    const parsed = footballGridResyncSchema.safeParse(payload);
    if (!parsed.success) return invalid(socket, 'grid:presence_heartbeat', parsed.error.flatten());
    runLimited(socket, 'grid:presence_heartbeat', 'heartbeat', () => footballGridRealtimeService.handlePresenceHeartbeat(socket, parsed.data.matchId));
  });
}
