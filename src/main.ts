import { startPartyRewardReconciler, stopPartyRewardReconciler } from './realtime/party-reward-reconciler.js';
import { startMobilePushWorker,stopMobilePushWorker } from './modules/notifications/mobile-push.worker.js';
import { startGuestJourneyWorker, stopGuestJourneyWorker } from './modules/guest/guest-journey.worker.js';
import { startPartnerDeliveryWorker, stopPartnerDeliveryWorker } from './modules/partners/delivery/worker.js';
import { getScoreDeliveryHealth } from './modules/partners/delivery/deliveries.js';
import { registerScoreDeliveryStatus } from './modules/partners/partner-status.js';
import { startRegisteredMemberCountWorker, stopRegisteredMemberCountWorker } from './modules/analytics/registered-members.worker.js';
import { startPartnerJanitor, stopPartnerJanitor } from './modules/partners/partner-janitor.js';
import { startPartnerDailiesSweeper, stopPartnerDailiesSweeper } from './modules/partners/games/dailies/daily-sweeper.js';
import { startQuizBoardSweeper, stopQuizBoardSweeper } from './modules/partners/games/quiz-board/index.js';
import { startPartnerRtgMinesSweeper, stopPartnerRtgMinesSweeper } from './modules/partners/games/road-to-goal/partner-rtg-mines.sweeper.js';
import { startPartnerGuessTheGoalSweeper, stopPartnerGuessTheGoalSweeper } from './modules/partners/games/guess-the-goal/index.js';
import { startPartnerCardDetectiveSweeper, stopPartnerCardDetectiveSweeper } from './modules/partners/games/card-detective/index.js';
import { startGuestSweeper, stopGuestSweeper } from './modules/guest/index.js';
import { startRoadToGoalSweeper, stopRoadToGoalSweeper, startRoadToGoalBots, stopRoadToGoalBots } from './modules/road-to-goal/index.js';
import { startSquadSpinSweeper, stopSquadSpinSweeper, startSquadSpinBots, stopSquadSpinBots } from './modules/squad-spin/index.js';
import { startTriviaMinesSweeper, stopTriviaMinesSweeper, startTriviaMinesBots, stopTriviaMinesBots } from './modules/trivia-mines/index.js';
import { startFreeKicksSweeper, stopFreeKicksSweeper, startFreeKicksBots, stopFreeKicksBots } from './modules/free-kicks/index.js';
import { startBuscaminasReadinessCheck } from './modules/buscaminas/index.js';
import { startPistasReadinessCheck } from './modules/pistas/index.js';
import { startUltimoReadinessCheck } from './modules/ultimo/index.js';
import { startSharedPlayerDailyReadinessCheck } from './modules/shared-player-daily/shared-player-daily.service.js';
import { startNameChainDailyReadinessCheck } from './modules/name-chain-daily/name-chain-daily.service.js';
import { startMinutoReadinessCheck } from './modules/minuto/index.js';
import { createServer } from 'http';
import { startSeason3FeedbackWorker, stopSeason3FeedbackWorker } from './modules/feedback/season3.service.js';
import { stopWlRewardsWorker } from './modules/weekend-league/wl-rewards.js';
import { createApp } from './app.js';
import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { shutdownLokiLogStream } from './core/loki.js';
import { shutdownTelemetry } from './core/otel.js';
import {
  dbPoolStats,
  disconnectDb,
  withDbWatchdogProbe,
} from './db/index.js';
import { DbWatchdog } from './db/watchdog.js';
import { initSocketServer, stopPartnerRankedRealtime } from './realtime/socket-server.js';
import { closeRedisClients } from './realtime/redis.js';
import { shutdownPostHog } from './core/analytics.js';
import { startAiFriendResponder, stopAiFriendResponder } from './modules/friends/ai-friend-responder.service.js';
import {
  startBotChallengeResponder,
  stopBotChallengeResponder,
} from './modules/lobbies/bot-challenge-responder.service.js';
import { startBotRenameWorker, stopBotRenameWorker } from './modules/bots/bot-rename.service.js';
import {
  startDailyComebackReminderWorker,
  stopDailyComebackReminderWorker,
} from './modules/daily-challenges/daily-comeback-reminders.worker.js';
import {
  startRetentionEmailWorker,
  stopRetentionEmailWorker,
} from './modules/retention-email/retention-email.worker.js';

const app = createApp();
const httpServer = createServer(app);
const io = await initSocketServer(httpServer);

// Node's 5s keep-alive default is shorter than the Railway edge proxy's
// connection-reuse window: the proxy can send a request down a connection the
// app is simultaneously closing, surfacing as sporadic 502/ECONNRESET at the
// edge. Outlive the proxy's idle timeout so the proxy always closes first.
httpServer.keepAliveTimeout = 75_000;
httpServer.headersTimeout = 80_000;

const server = httpServer.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
    },
    `Server started on port ${config.PORT} with Socket.IO`
  );
});
startAiFriendResponder();
startGuestSweeper();
startGuestJourneyWorker();
// Idle until PARTNER_FREECROCO_CONFIG carries Freecroco's score-events webhook.
startPartnerDeliveryWorker();
registerScoreDeliveryStatus(async () => ({ ...(await getScoreDeliveryHealth()), measuredAt: new Date() }));
startRegisteredMemberCountWorker();
startPartnerJanitor();
startPartnerDailiesSweeper();
startQuizBoardSweeper();
startPartnerRtgMinesSweeper();
startPartnerGuessTheGoalSweeper();
startPartnerCardDetectiveSweeper();
startRoadToGoalSweeper();
startRoadToGoalBots();
startSquadSpinSweeper();
startSquadSpinBots();
startTriviaMinesSweeper();
startPartyRewardReconciler();
startTriviaMinesBots();
startFreeKicksSweeper();
startFreeKicksBots();
// Both no-op when PERSISTENT_BOTS_ENABLED is off (checked inside each start).
startBotChallengeResponder();
startBotRenameWorker();
startDailyComebackReminderWorker();
startMobilePushWorker();
startRetentionEmailWorker();
startSeason3FeedbackWorker();
// Loads the Buscaminas days in the background; warns once if none are seeded.
startBuscaminasReadinessCheck();
// Same for the Pistas futboleras days.
startPistasReadinessCheck();
startUltimoReadinessCheck();
startSharedPlayerDailyReadinessCheck();
startNameChainDailyReadinessCheck();
startMinutoReadinessCheck();

const dbWatchdog = new DbWatchdog({
  probe: () => withDbWatchdogProbe(async (tx) => {
    await tx.unsafe('SELECT 1');
  }, 2_000, Math.max(500, config.DB_WATCHDOG_TIMEOUT_MS - 500)),
  intervalMs: config.DB_WATCHDOG_INTERVAL_MS,
  timeoutMs: config.DB_WATCHDOG_TIMEOUT_MS,
  maxFailures: config.DB_WATCHDOG_FAILURES,
  onFailure: (error, failures, maxFailures) => {
    logger.error(
      { error, failures, maxFailures, pool: dbPoolStats() },
      'Database watchdog probe failed'
    );
  },
  onRecovery: (previousFailures) => {
    logger.info({ previousFailures, pool: dbPoolStats() }, 'Database watchdog recovered');
  },
  onFatal: (error) => {
    logger.fatal(
      { error, pool: dbPoolStats() },
      'Database pool is unrecoverable; exiting so Railway replaces this replica'
    );
    process.exit(1);
  },
});

if (config.NODE_ENV !== 'local' && config.DB_WATCHDOG_ENABLED) {
  dbWatchdog.start();
}

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Received shutdown signal');
  dbWatchdog.stop();
  stopRoadToGoalBots();
  stopSquadSpinBots();
  stopTriviaMinesBots();
  stopFreeKicksBots();
  // Stop responder ticks immediately (server.close waits for open connections,
  // during which the interval could still fire) and drain the in-flight tick
  // before the DB pool closes so a mid-tick accept never hits a closing pool.
  const responderStopped = Promise.all([
    stopAiFriendResponder(),
    stopGuestSweeper(),
    stopGuestJourneyWorker(),
    stopPartnerDeliveryWorker(),
    stopRegisteredMemberCountWorker(),
    stopPartnerJanitor(),
    stopPartnerDailiesSweeper(),
    stopQuizBoardSweeper(),
    stopPartnerRtgMinesSweeper(),
    stopPartnerGuessTheGoalSweeper(),
    stopPartnerCardDetectiveSweeper(),
    stopRoadToGoalSweeper(),
    stopSquadSpinSweeper(),
    stopTriviaMinesSweeper(),
    stopPartyRewardReconciler(),
    stopFreeKicksSweeper(),
    stopBotChallengeResponder(),
    stopBotRenameWorker(),
    stopDailyComebackReminderWorker(),
    stopMobilePushWorker(),
    stopRetentionEmailWorker(),
    stopSeason3FeedbackWorker(),
    stopWlRewardsWorker(),
  ]).catch((error) => {
    logger.error({ error }, 'Shutdown cleanup step failed');
  });
  // A Freecroco ranked reconciliation still running settles through the socket server: let it finish first.
  await stopPartnerRankedRealtime().catch((error) => logger.error({ error }, 'Shutdown cleanup step failed'));
  io.close();
  server.close(async () => {
    await responderStopped;
    const results = await Promise.allSettled([
      closeRedisClients(),
      shutdownPostHog(),
      shutdownLokiLogStream(),
      shutdownTelemetry(),
      disconnectDb(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error({ error: result.reason }, 'Shutdown cleanup step failed');
      }
    }
    logger.info('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
