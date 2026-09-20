import type { ChaosUser } from './auth.js';
import { newRouteMetrics, type RouteMetrics } from './metrics.js';

export interface LoginStormConfig {
  apiBase: string;
  users: ChaosUser[];
  rampSec: number;
  timeoutMs: number;
  bypassToken?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One real arrival journey per player, ramped like an audience opening a stream
 * link: login -> hydrate profile -> hydrate wallet. Socket matchmaking runs in
 * parallel from the same fleet, so the cold arrival burst and gameplay overlap.
 */
export async function runLoginStorm(cfg: LoginStormConfig): Promise<RouteMetrics[]> {
  const loginMetrics = newRouteMetrics('arrival.login');
  const meMetrics = newRouteMetrics('arrival.users.me');
  const walletMetrics = newRouteMetrics('arrival.store.wallet');
  const rampMs = Math.max(0, cfg.rampSec * 1000);
  const requests = cfg.users.map(async (user, index) => {
    const delayMs = cfg.users.length > 1
      ? Math.round(rampMs * index / (cfg.users.length - 1))
      : 0;
    if (delayMs > 0) await sleep(delayMs);

    const login = await measuredFetch(loginMetrics, cfg.timeoutMs, `${cfg.apiBase}/api/v1/auth/login`, {
      method: 'POST',
      headers: headers(cfg.bypassToken, true),
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    const loginBody = (await login?.json().catch(() => ({}))) as { access_token?: string } | undefined;
    if (!login?.ok || !loginBody?.access_token) return;
    user.token = loginBody.access_token;

    await sleep(200 + Math.random() * 800);
    await measuredFetch(meMetrics, cfg.timeoutMs, `${cfg.apiBase}/api/v1/users/me`, {
      headers: { ...headers(cfg.bypassToken), Authorization: `Bearer ${user.token}` },
    });
    await sleep(200 + Math.random() * 800);
    await measuredFetch(walletMetrics, cfg.timeoutMs, `${cfg.apiBase}/api/v1/store/wallet`, {
      headers: { ...headers(cfg.bypassToken), Authorization: `Bearer ${user.token}` },
    });
  });

  await Promise.all(requests);
  return [loginMetrics, meMetrics, walletMetrics];
}

function headers(bypassToken: string | undefined, json = false): Record<string, string> {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(bypassToken ? { 'x-chaos-bypass': bypassToken } : {}),
  };
}

async function measuredFetch(
  metrics: RouteMetrics,
  timeoutMs: number,
  url: string,
  init: RequestInit
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  metrics.sent += 1;
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    metrics.completed += 1;
    metrics.latenciesMs.push(performance.now() - started);
    const status = String(response.status);
    metrics.statusHist[status] = (metrics.statusHist[status] ?? 0) + 1;
    if (response.status >= 500) metrics.errors += 1;
    else if (response.status >= 400) metrics.clientErrors += 1;
    return response;
  } catch (error) {
    metrics.latenciesMs.push(performance.now() - started);
    metrics.errors += 1;
    const status = (error as Error)?.name === 'AbortError' ? 'timeout' : 'neterr';
    metrics.statusHist[status] = (metrics.statusHist[status] ?? 0) + 1;
    return null;
  } finally {
    clearTimeout(timer);
  }
}
