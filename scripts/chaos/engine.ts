// Open-loop load engine. For each route it schedules requests at a fixed target
// RPS using a steady tick, independent of how fast responses come back, so a
// slow backend shows up as growing latency + in-flight backlog rather than a
// self-throttled lower rate. A global in-flight cap protects against unbounded
// memory if the target stalls completely.

import type { ChaosRoute, ChaosRouteFixtures, RouteBodyContext } from './routes.js';
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
  fixtures?: ChaosRouteFixtures;
}

export interface MixedEngineConfig extends EngineConfig {
  /** Total HTTP requests/sec across the weighted route mix. */
  totalRps: number;
  /** Linear ramp from 0 to totalRps. */
  rampSec: number;
}

function pickUser(users: ChaosUser[], i: number): ChaosUser {
  return users[i % users.length];
}

function routeContext(cfg: EngineConfig, user: ChaosUser, seq: number): RouteBodyContext {
  const other = cfg.users.length > 1 ? pickUser(cfg.users, seq + 1) : user;
  return {
    userId: user.userId,
    email: user.email,
    otherUserId: other.userId,
    categoryId: cfg.fixtures?.categoryId ?? '',
    questionId: cfg.fixtures?.questionId ?? '',
    featuredCategoryId: cfg.fixtures?.featuredCategoryId ?? '',
  };
}

function buildUrl(apiBase: string, route: ChaosRoute, ctx: RouteBodyContext): string {
  const routePath = typeof route.path === 'function' ? route.path(ctx) : route.path;
  const resolvedPath = routePath.replace(/\{(\w+)\}/g, (_match, name: keyof RouteBodyContext) => String(ctx[name] ?? ''));
  const query = typeof route.query === 'function' ? route.query(ctx) : route.query;
  return `${apiBase}${resolvedPath}${query ? `?${query}` : ''}`;
}

async function fireRequest(
  route: ChaosRoute,
  cfg: EngineConfig,
  inflight: { count: number },
  metrics: RouteMetrics,
  seq: number,
  selectedUser?: ChaosUser
): Promise<void> {
  if (inflight.count >= cfg.maxInflight) {
    metrics.sent++;
    metrics.errors++;
    metrics.statusHist.shed = (metrics.statusHist.shed ?? 0) + 1;
    return;
  }
  const user = selectedUser ?? pickUser(cfg.users, seq);
  const ctx = routeContext(cfg, user, seq);
  const url = buildUrl(cfg.apiBase, route, ctx);
  const headers: Record<string, string> = {};
  if (route.auth === 'bearer') headers.Authorization = `Bearer ${user.token}`;
  if (cfg.bypassToken) headers['x-chaos-bypass'] = cfg.bypassToken;
  let bodyStr: string | undefined;
  if (route.body) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(route.body(ctx));
  }
  inflight.count++;
  metrics.sent++;
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
    metrics.completed++;
    metrics.latenciesMs.push(dur);
    metrics.bytesIn += buf.byteLength;
    const code = String(res.status);
    metrics.statusHist[code] = (metrics.statusHist[code] ?? 0) + 1;
    if (res.status >= 500) metrics.errors++;
    else if (res.status >= 400 && !route.expectedStatuses?.includes(res.status)) metrics.clientErrors++;
  } catch (err) {
    const dur = performance.now() - start;
    metrics.latenciesMs.push(dur);
    metrics.errors++;
    const tag = (err as Error)?.name === 'AbortError' ? 'timeout' : 'neterr';
    metrics.statusHist[tag] = (metrics.statusHist[tag] ?? 0) + 1;
  } finally {
    clearTimeout(timer);
    inflight.count--;
  }
}

export async function runRoute(
  route: ChaosRoute,
  cfg: EngineConfig,
  inflight: { count: number },
  phaseOffsetMs = 0
): Promise<RouteMetrics> {
  const m = newRouteMetrics(route.name);
  const intervalMs = 1000 / cfg.rps;
  const startedAt = Date.now();
  const endAt = startedAt + cfg.durationSec * 1000;
  let i = 0;
  const pending = new Set<Promise<void>>();

  // Steady open-loop scheduler: tick every intervalMs, launch one request,
  // never awaiting it inline (fire-and-track).
  await new Promise<void>((resolve) => {
    const tick = () => {
      const now = Date.now();
      if (now >= endAt) {
        resolve();
        return;
      }
      const p = fireRequest(route, cfg, inflight, m, i++);
      pending.add(p);
      p.finally(() => pending.delete(p));
      // Self-correcting schedule: align next tick to the grid so drift from
      // slow fireOne setup doesn't lower the effective rate.
      const nextAt = phaseOffsetMs + i * intervalMs;
      const elapsed = Date.now() - startedAt;
      const delay = Math.max(0, nextAt - elapsed);
      setTimeout(tick, delay);
    };
    setTimeout(tick, Math.max(0, phaseOffsetMs));
  });

  // Drain outstanding requests so their latencies are recorded.
  await Promise.allSettled([...pending]);
  return m;
}

function weightedRoute(routes: ChaosRoute[], seq: number): ChaosRoute {
  const totalWeight = routes.reduce((sum, route) => sum + Math.max(0, route.weight), 0);
  if (totalWeight <= 0) return routes[seq % routes.length]!;
  let slot = seq % totalWeight;
  for (const route of routes) {
    slot -= Math.max(0, route.weight);
    if (slot < 0) return route;
  }
  return routes[routes.length - 1]!;
}

function offeredRequestsAt(elapsedSec: number, totalRps: number, rampSec: number): number {
  const ramp = Math.max(0, rampSec);
  if (ramp === 0 || elapsedSec >= ramp) {
    return totalRps * (elapsedSec - ramp / 2);
  }
  // Integral of a linear 0 -> totalRps ramp.
  return totalRps * elapsedSec * elapsedSec / (2 * ramp);
}

/**
 * Production-shaped open-loop traffic: one TOTAL RPS budget distributed by
 * route weight, rather than `rps × every route`. This models humans and makes a
 * player-count capacity ladder comparable between runs.
 */
export async function runMixedRoutes(
  routes: ChaosRoute[],
  cfg: MixedEngineConfig
): Promise<RouteMetrics[]> {
  if (routes.length === 0) return [];
  const inflight = { count: 0 };
  const metrics = new Map(routes.map((route) => [route.name, newRouteMetrics(route.name)]));
  const pending = new Set<Promise<void>>();
  const startedAt = Date.now();
  const durationMs = cfg.durationSec * 1000;
  const perUserRouteCounts = new Map<string, Map<string, number>>();
  let sent = 0;

  const routeHasCapacity = (route: ChaosRoute): boolean => {
    if (route.maxPerUser === undefined) return true;
    const counts = perUserRouteCounts.get(route.name);
    const used = counts ? [...counts.values()].reduce((sum, count) => sum + count, 0) : 0;
    return used < route.maxPerUser * cfg.users.length;
  };

  const reserveRouteUser = (route: ChaosRoute, seq: number): ChaosUser => {
    if (route.maxPerUser === undefined) return pickUser(cfg.users, seq);
    const counts = perUserRouteCounts.get(route.name) ?? new Map<string, number>();
    perUserRouteCounts.set(route.name, counts);
    for (let offset = 0; offset < cfg.users.length; offset++) {
      const candidate = pickUser(cfg.users, seq + offset);
      const used = counts.get(candidate.userId) ?? 0;
      if (used < route.maxPerUser) {
        counts.set(candidate.userId, used + 1);
        return candidate;
      }
    }
    throw new Error(`No remaining user capacity for mixed route ${route.name}`);
  };

  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsedMs = Date.now() - startedAt;
      const boundedElapsedSec = Math.min(cfg.durationSec, elapsedMs / 1000);
      const desired = Math.floor(offeredRequestsAt(
        boundedElapsedSec,
        cfg.totalRps,
        Math.min(cfg.rampSec, cfg.durationSec)
      ));

      while (sent < desired) {
        const seq = sent++;
        const eligibleRoutes = routes.filter(routeHasCapacity);
        if (eligibleRoutes.length === 0) break;
        const route = weightedRoute(eligibleRoutes, seq);
        const user = reserveRouteUser(route, seq);
        const routeMetrics = metrics.get(route.name)!;
        const request = fireRequest(route, cfg, inflight, routeMetrics, seq, user);
        pending.add(request);
        request.finally(() => pending.delete(request));
      }

      if (elapsedMs >= durationMs) {
        resolve();
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });

  await Promise.allSettled([...pending]);
  return [...metrics.values()];
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
  // Spread the route phases across one request interval. Starting every route
  // on the same millisecond manufactured an artificial thundering herd (for
  // example 33 requests exactly on every one-second boundary at 1 RPS/route),
  // which measures burst tolerance rather than a steady open-loop rate.
  const intervalMs = 1000 / cfg.rps;
  const all = routes.map((route, index) => {
    onRouteStart?.(route.name);
    return runRoute(route, cfg, inflight, intervalMs * index / routes.length);
  });
  for (const r of await Promise.all(all)) results.push(r);
  return results;
}
