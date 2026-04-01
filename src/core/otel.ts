import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

let sdkInstance: NodeSDK | null = null;
let initPromise: Promise<void> | null = null;

function telemetryEnabled(): boolean {
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim());
}

function shouldExportTraces(): boolean {
  return process.env.OTEL_TRACES_EXPORTER !== 'none';
}

function shouldExportMetrics(): boolean {
  return process.env.OTEL_METRICS_EXPORTER !== 'none';
}

export async function initTelemetry(): Promise<void> {
  if (!telemetryEnabled()) return;
  if (sdkInstance) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (process.env.OTEL_DEBUG === 'true') {
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
    }

    const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || 'quizball-backend';
    const traceExporter = shouldExportTraces() ? new OTLPTraceExporter() : undefined;
    const metricReader = shouldExportMetrics()
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: 60000,
        })
      : undefined;

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
      }),
      autoDetectResources: true,
      instrumentations: [
        getNodeAutoInstrumentations(),
      ],
      ...(traceExporter ? { traceExporter } : {}),
      ...(metricReader ? { metricReader } : {}),
    });

    await sdk.start();
    sdkInstance = sdk;
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdkInstance) return;
  const sdk = sdkInstance;
  sdkInstance = null;
  await sdk.shutdown();
}
