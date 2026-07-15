// Last-resort process guards, registered before anything else loads. One
// rejection is logged so realtime recovery can absorb a lost detached task, but
// a burst means the replica's state/pool can no longer be trusted. Continuing
// indefinitely caused one Railway replica to remain wedged during the
// 2026-07-13 database incident until it was manually redeployed.
const UNHANDLED_REJECTION_WINDOW_MS = 60_000;
const UNHANDLED_REJECTION_RESTART_THRESHOLD = 3;
const recentUnhandledRejections: number[] = [];
let fatalRestartScheduled = false;

process.on('unhandledRejection', (reason) => {
  const now = Date.now();
  recentUnhandledRejections.push(now);
  while (
    recentUnhandledRejections.length > 0
    && recentUnhandledRejections[0]! < now - UNHANDLED_REJECTION_WINDOW_MS
  ) {
    recentUnhandledRejections.shift();
  }

  const count = recentUnhandledRejections.length;
  console.error(
    `[FATAL-GUARD] Unhandled promise rejection (${count}/${UNHANDLED_REJECTION_RESTART_THRESHOLD} in 60s):`,
    reason
  );
  if (count >= UNHANDLED_REJECTION_RESTART_THRESHOLD && !fatalRestartScheduled) {
    fatalRestartScheduled = true;
    console.error('[FATAL-GUARD] Rejection burst detected; exiting for clean replica replacement.');
    setTimeout(() => process.exit(1), 100).unref?.();
  }
});

process.on('uncaughtException', (error) => {
  // Synchronous state may be corrupt — log with full detail, then exit and
  // let the platform restart us cleanly.
  console.error('[FATAL-GUARD] Uncaught exception (exiting):', error);
  process.exit(1);
});

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) {
  try {
    const { initTelemetry } = await import('./core/otel.js');
    await initTelemetry();
  } catch (error) {
    console.error('Failed to initialize OpenTelemetry; continuing without telemetry', error);
  }
}

await import('./main.js');
