if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) {
  try {
    const { initTelemetry } = await import('./core/otel.js');
    await initTelemetry();
  } catch (error) {
    console.error('Failed to initialize OpenTelemetry; continuing without telemetry', error);
  }
}

await import('./main.js');
