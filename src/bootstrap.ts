if (process.env.NEW_RELIC_ENABLED === 'true' && process.env.NODE_ENV === 'prod') {
  try {
    await import('newrelic');
  } catch (error) {
    console.error('Failed to import newrelic; continuing without APM', error);
  }
}

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) {
  try {
    const { initTelemetry } = await import('./core/otel.js');
    await initTelemetry();
  } catch (error) {
    console.error('Failed to initialize OpenTelemetry; continuing without telemetry', error);
  }
}

await import('./main.js');
