/**
 * External-source collectors for the staging gate: pull Railway deploy logs and
 * PostHog events for a played match's window/users, via the provider HTTP APIs
 * (no MCP — these run unattended). All fail OPEN (return an "unavailable" marker)
 * so a missing token / API hiccup never crashes the gate.
 *
 * Creds (from .env.staging, never committed):
 *   Railway:  RAILWAY_TOKEN  (+ RAILWAY_SERVICE_ID / RAILWAY_ENVIRONMENT_ID — defaulted to staging)
 *   PostHog:  POSTHOG_API_HOST, POSTHOG_PROJECT_ID, POSTHOG_PERSONAL_API_KEY
 */

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

export interface LogCollection {
  ok: boolean;
  unavailable?: string;
  errorLines: string[];   // error/warn log lines in the window
  scanned: number;
}

export interface AnalyticsCollection {
  ok: boolean;
  unavailable?: string;
  byEvent: Record<string, number>;   // event -> count for this user/window
  errorEvents: number;               // count of error_occurred
}

/** Railway deploy logs for the staging service, filtered to error/warn, in a window. */
export async function collectRailwayErrors(opts: {
  sinceMs: number; untilMs: number;
}): Promise<LogCollection> {
  const token = process.env.RAILWAY_TOKEN;
  const serviceId = process.env.RAILWAY_SERVICE_ID ?? 'f686a274-653b-48e1-ac91-74e0882113bd';
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID ?? '8eb31d59-ff31-4fee-9468-a747b8d29de4';
  if (!token) return { ok: true, unavailable: 'no RAILWAY_TOKEN', errorLines: [], scanned: 0 };

  // Railway PROJECT tokens auth via the Project-Access-Token header (NOT Bearer).
  const railwayHeaders = { 'Project-Access-Token': token, 'Content-Type': 'application/json' };
  const projectId = process.env.RAILWAY_PROJECT_ID ?? 'f69e88c4-9afa-4640-8748-f592350dd58e';

  // Resolve the latest deployment for the staging service/env, then read its logs.
  const depQuery = `query($input: DeploymentListInput!) {
    deployments(input: $input, first: 1) { edges { node { id } } }
  }`;
  try {
    const depRes = await fetch(RAILWAY_API, {
      method: 'POST',
      headers: railwayHeaders,
      body: JSON.stringify({ query: depQuery, variables: { input: { projectId, serviceId, environmentId } } }),
    });
    const depJson = await depRes.json() as { data?: { deployments?: { edges?: Array<{ node?: { id?: string } }> } }; errors?: unknown };
    const deploymentId = depJson.data?.deployments?.edges?.[0]?.node?.id;
    if (!deploymentId) return { ok: true, unavailable: `no deployment (${JSON.stringify(depJson.errors ?? 'none')})`, errorLines: [], scanned: 0 };

    const logsQuery = `query($deploymentId: String!, $startDate: DateTime, $endDate: DateTime) {
      deploymentLogs(deploymentId: $deploymentId, startDate: $startDate, endDate: $endDate, limit: 1000) {
        message severity timestamp
      }
    }`;
    const logRes = await fetch(RAILWAY_API, {
      method: 'POST',
      headers: railwayHeaders,
      body: JSON.stringify({ query: logsQuery, variables: {
        deploymentId,
        startDate: new Date(opts.sinceMs - 5_000).toISOString(),
        endDate: new Date(opts.untilMs + 5_000).toISOString(),
      } }),
    });
    const logJson = await logRes.json() as { data?: { deploymentLogs?: Array<{ message: string; severity?: string; timestamp?: string }> } };
    const logs = logJson.data?.deploymentLogs ?? [];
    // Only flag REAL problems: error/warn/fatal SEVERITY, or genuine exception
    // signatures in the message. Do NOT match the bare word "error" in info-level
    // lines (e.g. the generic info-level "Application error" noise on staging).
    const errorLines = logs
      .filter((l) => {
        const sev = (l.severity ?? '').toLowerCase();
        if (sev === 'error' || sev === 'warn' || sev === 'warning' || sev === 'fatal' || sev === 'critical') return true;
        return /unhandled rejection|uncaught|stack trace|\bTypeError\b|\bReferenceError\b|ECONNREFUSED|NotFoundError|Cannot read prop/i.test(l.message);
      })
      .map((l) => `[${l.severity ?? '?'}] ${l.message}`);
    return { ok: true, errorLines, scanned: logs.length };
  } catch (err) {
    return { ok: true, unavailable: (err as Error).message, errorLines: [], scanned: 0 };
  }
}

/** PostHog events for given distinct ids in a time window (HogQL). */
export async function collectPostHogEvents(opts: {
  distinctIds: string[]; sinceMs: number; untilMs: number;
}): Promise<AnalyticsCollection> {
  const host = process.env.POSTHOG_API_HOST;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!host || !projectId || !key) return { ok: true, unavailable: 'no PostHog creds', byEvent: {}, errorEvents: 0 };

  const ids = opts.distinctIds.map((d) => `'${d.replace(/'/g, '')}'`).join(',');
  const since = new Date(opts.sinceMs - 5_000).toISOString();
  const until = new Date(opts.untilMs + 60_000).toISOString();
  const hogql = `SELECT event, count() AS c FROM events
    WHERE timestamp > toDateTime('${since}') AND timestamp < toDateTime('${until}')
      AND distinct_id IN (${ids})
    GROUP BY event ORDER BY c DESC`;
  try {
    const res = await fetch(`${host}/api/projects/${projectId}/query/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
    });
    if (!res.ok) return { ok: true, unavailable: `http_${res.status}`, byEvent: {}, errorEvents: 0 };
    const json = await res.json() as { results?: Array<[string, number]> };
    const byEvent: Record<string, number> = {};
    for (const [ev, c] of json.results ?? []) byEvent[ev] = c;
    return { ok: true, byEvent, errorEvents: byEvent['error_occurred'] ?? 0 };
  } catch (err) {
    return { ok: true, unavailable: (err as Error).message, byEvent: {}, errorEvents: 0 };
  }
}
