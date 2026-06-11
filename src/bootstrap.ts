// Last-resort process guards, registered before anything else loads. A single
// unhandled promise rejection must NOT kill a realtime server holding live
// sockets and in-memory match/draft timers — observed on prod (2026-06-11):
// a DB statement timeout escaped a fire-and-forget draft-start path and
// crash-restarted the process three times in 90 seconds, dropping every
// connected player each time.
process.on('unhandledRejection', (reason) => {
  // Log loudly and keep serving. The rejected promise's work is lost, but the
  // realtime recovery layers (watchdogs, durable timers, reconnect resume)
  // are designed to absorb exactly this kind of partial failure.
  console.error('[FATAL-GUARD] Unhandled promise rejection (continuing):', reason);
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
