import { describe, expect, it } from 'vitest';
import { aggregateK6Summaries } from '../../scripts/load/k6/aggregate-summary.js';

describe('distributed k6 summary aggregation', () => {
  it('sums failure counters and uses conservative worker percentiles', () => {
    const aggregate = aggregateK6Summaries([
      { metrics: {
        http_reqs: { count: 100, rate: 10 },
        iterations: { count: 99 },
        checks: { passes: 99, fails: 1 },
        unexpected_failures: { passes: 1, fails: 98, value: 0.01 },
        http_req_failed: { passes: 1, fails: 99, value: 0.01 },
        app_request_duration: { 'p(95)': 100, 'p(99)': 200, max: 300 },
        http_req_duration: { 'p(95)': 150, 'p(99)': 250, max: 350 },
        'http_req_duration{endpoint:users.me}': { 'p(95)': 90, 'p(99)': 180, max: 250 },
      } },
      { metrics: {
        http_reqs: { count: 200, rate: 20 },
        iterations: { count: 200 },
        dropped_iterations: { count: 2 },
        server_error_responses: { count: 1 },
        checks: { passes: 200, fails: 0 },
        unexpected_failures: { passes: 0, fails: 200, value: 0 },
        http_req_failed: { passes: 0, fails: 200, value: 0 },
        app_request_duration: { 'p(95)': 120, 'p(99)': 240, max: 400 },
        http_req_duration: { 'p(95)': 170, 'p(99)': 270, max: 450 },
        'http_req_duration{endpoint:users.me}': { 'p(95)': 110, 'p(99)': 220, max: 350 },
      } },
    ]);

    expect(aggregate).toMatchObject({
      ok: false,
      workers: 2,
      throughputRps: 30,
      totals: {
        requests: 300,
        iterations: 299,
        droppedIterations: 2,
        serverErrors: 1,
        checkFailures: 1,
        unexpectedFailures: 1,
        httpFailures: 1,
      },
      latencyMs: {
        metric: 'app_request_duration',
        worstWorkerP95: 120,
        worstWorkerP99: 240,
        max: 400,
      },
      endpoints: [{
        endpoint: 'users.me',
        workers: 2,
        worstWorkerP95Ms: 110,
        worstWorkerP99Ms: 220,
        maxMs: 350,
      }],
    });
  });

  it('passes a clean distributed summary', () => {
    expect(aggregateK6Summaries([{ metrics: {
      http_reqs: { count: 10, rate: 5 },
      iterations: { count: 10 },
      checks: { passes: 10, fails: 0 },
      unexpected_failures: { passes: 0, fails: 10, value: 0 },
      http_req_failed: { passes: 0, fails: 10, value: 0 },
      http_req_duration: { 'p(95)': 100, 'p(99)': 200, max: 250 },
    } }])).toMatchObject({ ok: true, violations: [] });
  });
});
