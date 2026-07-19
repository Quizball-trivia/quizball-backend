import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface K6Metric {
  count?: number;
  passes?: number;
  fails?: number;
  value?: number;
  rate?: number;
  avg?: number;
  min?: number;
  med?: number;
  max?: number;
  'p(90)'?: number;
  'p(95)'?: number;
  'p(99)'?: number;
}

interface K6Summary {
  metrics?: Record<string, K6Metric>;
}

export interface DistributedK6Aggregate {
  ok: boolean;
  workers: number;
  totals: {
    requests: number;
    iterations: number;
    droppedIterations: number;
    serverErrors: number;
    rateLimitedResponses: number;
    checkFailures: number;
    unexpectedFailures: number;
    httpFailures: number;
  };
  throughputRps: number;
  latencyMs: {
    worstWorkerP95: number;
    worstWorkerP99: number;
    max: number;
  };
  endpoints: Array<{
    endpoint: string;
    workers: number;
    worstWorkerP95Ms: number;
    worstWorkerP99Ms: number;
    maxMs: number;
  }>;
  violations: string[];
}

function metric(summary: K6Summary, name: string): K6Metric {
  return summary.metrics?.[name] ?? {};
}

function sum(summaries: K6Summary[], name: string, field: keyof K6Metric): number {
  return summaries.reduce((total, summary) => total + Number(metric(summary, name)[field] ?? 0), 0);
}

function max(summaries: K6Summary[], name: string, field: keyof K6Metric): number {
  return summaries.reduce(
    (highest, summary) => Math.max(highest, Number(metric(summary, name)[field] ?? 0)),
    0
  );
}

export function aggregateK6Summaries(summaries: K6Summary[]): DistributedK6Aggregate {
  if (summaries.length === 0) throw new Error('At least one k6 worker summary is required.');

  const totals = {
    requests: sum(summaries, 'http_reqs', 'count'),
    iterations: sum(summaries, 'iterations', 'count'),
    droppedIterations: sum(summaries, 'dropped_iterations', 'count'),
    serverErrors: sum(summaries, 'server_error_responses', 'count'),
    rateLimitedResponses: sum(summaries, 'rate_limited_responses', 'count'),
    checkFailures: sum(summaries, 'checks', 'fails'),
    // k6 Rate summaries call true samples "passes". These two rates add true
    // only for an actual failure, so passes are the failure counts.
    unexpectedFailures: sum(summaries, 'unexpected_failures', 'passes'),
    httpFailures: sum(summaries, 'http_req_failed', 'passes'),
  };

  const endpointNames = new Set<string>();
  for (const summary of summaries) {
    for (const name of Object.keys(summary.metrics ?? {})) {
      const match = name.match(/^http_req_duration\{endpoint:(.+)\}$/);
      if (match?.[1]) endpointNames.add(match[1]);
    }
  }
  const endpoints = [...endpointNames].sort().map((endpoint) => {
    const name = `http_req_duration{endpoint:${endpoint}}`;
    const workers = summaries.filter((summary) => summary.metrics?.[name]).length;
    return {
      endpoint,
      workers,
      worstWorkerP95Ms: max(summaries, name, 'p(95)'),
      worstWorkerP99Ms: max(summaries, name, 'p(99)'),
      maxMs: max(summaries, name, 'max'),
    };
  });

  const latencyMs = {
    // k6 summary exports do not contain raw samples, so distributed
    // percentiles cannot be recomputed exactly. The worst worker percentile is
    // deliberately conservative and is labeled as such in the report.
    worstWorkerP95: max(summaries, 'http_req_duration', 'p(95)'),
    worstWorkerP99: max(summaries, 'http_req_duration', 'p(99)'),
    max: max(summaries, 'http_req_duration', 'max'),
  };
  const violations: string[] = [];
  for (const [name, value] of Object.entries(totals)) {
    if (!['requests', 'iterations'].includes(name) && value > 0) {
      violations.push(`${name}=${value}`);
    }
  }
  if (latencyMs.worstWorkerP95 >= 1_500) {
    violations.push(`worst worker p95 ${latencyMs.worstWorkerP95.toFixed(1)}ms >= 1500ms`);
  }
  if (latencyMs.worstWorkerP99 >= 3_000) {
    violations.push(`worst worker p99 ${latencyMs.worstWorkerP99.toFixed(1)}ms >= 3000ms`);
  }

  return {
    ok: violations.length === 0,
    workers: summaries.length,
    totals,
    throughputRps: sum(summaries, 'http_reqs', 'rate'),
    latencyMs,
    endpoints,
    violations,
  };
}

function main(argv: string[]): void {
  const reportIndex = argv.indexOf('--report');
  const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : undefined;
  const inputs = argv.filter((value, index) => (
    value !== '--report' && index !== reportIndex + 1
  ));
  if (!reportPath || inputs.length === 0) {
    throw new Error('Usage: aggregate-summary.ts --report <aggregate.json> <worker.json...>');
  }
  const summaries = inputs.map((path) => JSON.parse(readFileSync(path, 'utf8')) as K6Summary);
  const aggregate = aggregateK6Summaries(summaries);
  const absoluteReport = resolve(reportPath);
  mkdirSync(dirname(absoluteReport), { recursive: true });
  writeFileSync(absoluteReport, `${JSON.stringify(aggregate, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
  if (!aggregate.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
