// Open-loop load engine. For each route it schedules requests at a fixed target
// RPS using a steady tick, independent of how fast responses come back, so a
// slow backend shows up as growing latency + in-flight backlog rather than a
// self-throttled lower rate. A global in-flight cap protects against unbounded
// memory if the target stalls completely.

import type { ChaosRoute } from './routes.js';
import type { ChaosUser } from './auth.js';
import { newRouteMetrics, type RouteMetrics } from './metrics.js';

export interface EngineConfig {
  apiBase: string;
  rps: number; // target requests/sec PER route
  durationSec: number;
  users: ChaosUser[];
  maxInflight: number; // global safety cap
  timeoutMs: number;
  bypassToken?: string; // x-chaos-bypass header to skip the app rate limiter
}

function pickUser(users: ChaosUser[], i: number): ChaosUser {
  return users[i % users.length];
}

function buildUrl(apiBase: string, route: ChaosRoute, user: ChaosUser): string {
  const path = route.path.replace('{userId}', user.userId);
  return `${apiBase}${path}${route.query ? `?${route.query}` : ''}`;
}

export async function runRoute(
  route: ChaosRoute,
  cfg: EngineConfig,
  inflight: { count: number }
): Promise<RouteMetrics> {
  const m = newRouteMetrics(route.name);
  const intervalMs = 1000 / cfg.rps;
  const endAt = Date.now() + cfg.durationSec * 1000;
  let i = 0;
  const pending = new Set<Promise<void>>();

  async function fireOne(seq: number): Promise<void> {
    if (inflight.count >= cfg.maxInflight) {
      // Shed rather than pile up unbounded; counts as a dropped send.
      m.sent++;
      m.errors++;
      m.statusHist['shed'] = (m.statusHist['shed'] ?? 0) + 1;
      return;
    }
    const user = pickUser(cfg.users, seq);
    const url = buildUrl(cfg.apiBase, route, user);
    const headers: Record<string, string> = {};
    if (route.auth === 'bearer') headers.Authorization = `Bearer ${user.token}`;
    if (cfg.bypassToken) headers['x-chaos-bypass'] = cfg.bypassToken;
    let bodyStr: string | undefined;
    if (route.body) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(route.body({ userId: user.userId, email: user.email }));
    }
    inflight.count++;
    m.sent++;
    const start = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: route.method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      const buf = await res.arrayBuffer();
      const dur = performance.now() - start;
      m.completed++;
      m.latenciesMs.push(dur);
      m.bytesIn += buf.byteLength;
      const code = String(res.status);
      m.statusHist[code] = (m.statusHist[code] ?? 0) + 1;
      if (res.status >= 500) m.errors++;
      else if (res.status >= 400) m.clientErrors++;
    } catch (err) {
      const dur = performance.now() - start;
      m.latenciesMs.push(dur);
      m.errors++;
      const tag = (err as Error)?.name === 'AbortError' ? 'timeout' : 'neterr';
      m.statusHist[tag] = (m.statusHist[tag] ?? 0) + 1;
    } finally {
      clearTimeout(timer);
      inflight.count--;
    }
  }

  // Steady open-loop scheduler: tick every intervalMs, launch one request,
  // never awaiting it inline (fire-and-track).
  await new Promise<void>((resolve) => {
    const tick = () => {
      const now = Date.now();
      if (now >= endAt) {
        resolve();
        return;
      }
      const p = fireOne(i++);
      pending.add(p);
      p.finally(() => pending.delete(p));
      // Self-correcting schedule: align next tick to the grid so drift from
      // slow fireOne setup doesn't lower the effective rate.
      const nextAt = i * intervalMs;
      const elapsed = Date.now() - (endAt - cfg.durationSec * 1000);
      const delay = Math.max(0, nextAt - elapsed);
      setTimeout(tick, delay);
    };
    tick();
  });

  // Drain outstanding requests so their latencies are recorded.
  await Promise.allSettled([...pending]);
  return m;
}

export async function runAllRoutes(
  routes: ChaosRoute[],
  cfg: EngineConfig,
  onRouteStart?: (name: string) => void
): Promise<RouteMetrics[]> {
  const inflight = { count: 0 };
  const results: RouteMetrics[] = [];
  // Run routes concurrently — they share the global in-flight cap so the
  // combined offered load is rps × routeCount, which is the point (max pressure).
  const all = routes.map((route) => {
    onRouteStart?.(route.name);
    return runRoute(route, cfg, inflight);
  });
  for (const r of await Promise.all(all)) results.push(r);
  return results;
}
