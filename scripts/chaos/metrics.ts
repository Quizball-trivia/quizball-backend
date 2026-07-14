// Per-route latency/throughput/error accumulation. Latencies are kept in a
// plain array per route (a chaos run is bounded, so memory is fine) and reduced
// to percentiles at report time.

export interface RouteMetrics {
  name: string;
  sent: number;
  completed: number;
  errors: number; // transport errors + 5xx
  clientErrors: number; // 4xx (often expected: 401/403/409)
  latenciesMs: number[];
  statusHist: Record<string, number>;
  bytesIn: number;
}

export function newRouteMetrics(name: string): RouteMetrics {
  return {
    name,
    sent: 0,
    completed: 0,
    errors: 0,
    clientErrors: 0,
    latenciesMs: [],
    statusHist: {},
    bytesIn: 0,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export interface RouteReport {
  name: string;
  sent: number;
  completed: number;
  errorRatePct: number;
  clientErrPct: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  statusHist: Record<string, number>;
}

export function summarize(m: RouteMetrics, durationSec: number): RouteReport {
  const sorted = [...m.latenciesMs].sort((a, b) => a - b);
  return {
    name: m.name,
    sent: m.sent,
    completed: m.completed,
    errorRatePct: m.sent ? (m.errors / m.sent) * 100 : 0,
    clientErrPct: m.sent ? (m.clientErrors / m.sent) * 100 : 0,
    rps: durationSec ? m.completed / durationSec : 0,
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    p99: Math.round(percentile(sorted, 99)),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
    statusHist: m.statusHist,
  };
}

export function renderTable(reports: RouteReport[]): string {
  const headers = ['route', 'sent', 'ok', 'rps', 'p50', 'p95', 'p99', 'max', 'err%', '4xx%', 'status'];
  const rows = reports.map((r) => [
    r.name,
    String(r.sent),
    String(r.completed),
    r.rps.toFixed(0),
    String(r.p50),
    String(r.p95),
    String(r.p99),
    String(r.max),
    r.errorRatePct.toFixed(1),
    r.clientErrPct.toFixed(1),
    Object.entries(r.statusHist)
      .sort()
      .map(([k, v]) => `${k}:${v}`)
      .join(' '),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length))
  );
  const fmt = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmt(headers), sep, ...rows.map(fmt)].join('\n');
}
