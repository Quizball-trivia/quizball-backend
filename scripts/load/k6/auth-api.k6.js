import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const MODE = (__ENV.MODE || 'smoke').toLowerCase();
const TARGET = (__ENV.TARGET || 'local').toLowerCase();
const API_BASE = (__ENV.API_BASE || (TARGET === 'staging'
  ? 'https://api-staging.quizball.io'
  : 'http://127.0.0.1:3000')).replace(/\/+$/, '');

const USER_COUNT = positiveInt('USERS', 25);
const VUS = positiveInt('VUS', MODE === 'smoke' ? Math.min(USER_COUNT, 2) : Math.min(USER_COUNT, 25));
const RATE = positiveInt('RATE', 25);
// Arrival-rate workers must cover both the steady request and each worker's
// one-time login. Under-allocation makes k6 drop work and falsely reports a
// lower offered load while the backend is still healthy.
const PREALLOCATED_VUS = positiveInt('PREALLOCATED_VUS', Math.max(VUS, RATE * 2));
const MAX_VUS = positiveInt('MAX_VUS', Math.max(PREALLOCATED_VUS, RATE * 4, 100));
const START_RATE = nonNegativeInt('START_RATE', Math.min(1, RATE));
const SHARD_START = nonNegativeInt('SHARD_START', 0);
const RAMP_DURATION = __ENV.RAMP_DURATION || '30s';
const DURATION = __ENV.DURATION || '2m';
const TIME_UNIT = __ENV.TIME_UNIT || '1s';
const REFRESH_PAUSE_SECONDS = positiveNumber('REFRESH_PAUSE_SECONDS', 5);
const PASSWORD = __ENV.TEST_PASSWORD || 'ChaosTest12345!';
const EMAIL_PREFIX = __ENV.EMAIL_PREFIX || 'chaos';
const EMAIL_DOMAIN = __ENV.EMAIL_DOMAIN || (TARGET === 'staging' ? 'quizball.io' : 'example.com');
const BYPASS_TOKEN = __ENV.CHAOS_BYPASS_TOKEN || '';
// API capacity and Auth capacity are separate tests. Arrival-rate executors may
// schedule work across every preallocated VU, so a "login once per VU" design
// can create a hidden login storm before the API load reaches its target. The
// default shared session performs exactly one setup login; use per-vu only when
// intentionally testing a realistic spread of user identities at a safe rate.
const API_SESSION_MODE = (__ENV.API_SESSION_MODE || 'shared').toLowerCase();
const SHARED_SESSION_TTL_SECONDS = 3_600;
const SHARED_SESSION_SAFETY_SECONDS = 60;

const unexpectedFailures = new Rate('unexpected_failures');
const rateLimitedResponses = new Counter('rate_limited_responses');
const loginRateLimited = new Counter('auth_login_rate_limited');
const refreshRateLimited = new Counter('auth_refresh_rate_limited');
const signupRateLimited = new Counter('auth_signup_rate_limited');
const serverErrorResponses = new Counter('server_error_responses');
const supabaseAuthRateLimited = new Counter('supabase_auth_rate_limited');
const applicationRateLimited = new Counter('application_rate_limited');
const unknownRateLimited = new Counter('unknown_rate_limited');
const appRequestDuration = new Trend('app_request_duration', true);
const loginDuration = new Trend('auth_login_duration', true);
const refreshDuration = new Trend('auth_refresh_duration', true);
const signupDuration = new Trend('auth_signup_duration', true);
const walletDuration = new Trend('wallet_duration', true);

assertSafeConfiguration();

export const options = buildOptions();

const SAFE_API_ROUTES = [
  { name: 'categories.list', path: '/api/v1/categories?limit=100&is_active=true&page=1', weight: 6, auth: false },
  { name: 'categories.list.minq', path: '/api/v1/categories?limit=100&is_active=true&min_questions=5', weight: 4, auth: false },
  { name: 'questions.list', path: '/api/v1/questions?limit=50&page=1&status=published', weight: 5, auth: true },
  { name: 'featured.list', path: '/api/v1/featured-categories', weight: 3, auth: false },
  { name: 'store.products', path: '/api/v1/store/products', weight: 3, auth: false },
  { name: 'users.me', path: '/api/v1/users/me', weight: 6, auth: true },
  { name: 'users.me.achievements', path: '/api/v1/users/me/achievements', weight: 2, auth: true },
  { name: 'ranked.profile', path: '/api/v1/ranked/profile', weight: 5, auth: true },
  { name: 'ranked.leaderboard.global', path: '/api/v1/ranked/leaderboard?scope=global&limit=50&offset=0', weight: 5, auth: true },
  { name: 'ranked.leaderboard.country', path: '/api/v1/ranked/leaderboard?scope=country&limit=50&offset=0', weight: 4, auth: true },
  { name: 'ranked.leaderboard.me', path: '/api/v1/ranked/leaderboard/me?scope=global', weight: 4, auth: true },
  { name: 'stats.summary', path: '/api/v1/stats/summary', weight: 4, auth: true },
  { name: 'stats.recent', path: '/api/v1/stats/recent-matches?limit=10', weight: 4, auth: true },
  { name: 'store.wallet', path: '/api/v1/store/wallet', weight: 4, auth: true },
  { name: 'store.inventory', path: '/api/v1/store/inventory', weight: 3, auth: true },
  { name: 'daily.list', path: '/api/v1/daily-challenges', weight: 4, auth: true },
  { name: 'objectives.list', path: '/api/v1/objectives', weight: 3, auth: true },
  { name: 'lobbies.public', path: '/api/v1/lobbies/public', weight: 3, auth: true },
  { name: 'friends.list', path: '/api/v1/friends', weight: 2, auth: true },
  { name: 'friends.requests', path: '/api/v1/friends/requests', weight: 2, auth: true },
  { name: 'announcements.list', path: '/api/v1/announcements', weight: 2, auth: true },
  { name: 'notifications.list', path: '/api/v1/notifications?limit=20', weight: 2, auth: true },
  { name: 'notifications.unread', path: '/api/v1/notifications/unread-count', weight: 2, auth: true },
  { name: 'users.search', path: '/api/v1/users/search?q=chaos&limit=20', weight: 2, auth: true },
];

let apiSession = null;
let refreshSession = null;
let walletSession = null;

export function setup() {
  if (!['api', 'auth-mix'].includes(MODE) || API_SESSION_MODE !== 'shared') return {};

  const session = login(SHARD_START);
  if (!session) {
    throw new Error('API shared-session setup failed; refusing to run an unauthenticated capacity test.');
  }
  return { apiSession: session };
}

export function smokeJourney() {
  const session = login(userIndexForVu());
  if (!session) return;

  getAuthenticated('/api/v1/users/me', session.accessToken, 'users.me');
  getWallet(session.accessToken);

  if (!session.refreshToken) {
    failCheck('smoke.login returned a refresh token', false);
    return;
  }
  const rotated = refresh(session.refreshToken);
  if (rotated?.accessToken) {
    getAuthenticated('/api/v1/users/me', rotated.accessToken, 'users.me.after_refresh');
  }
}

export function loginArrival() {
  login(userIndexForArrival());
}

export function refreshLoop() {
  if (!refreshSession) {
    refreshSession = login(userIndexForVu());
    if (!refreshSession?.refreshToken) {
      sleep(1);
      return;
    }
  }

  const rotated = refresh(refreshSession.refreshToken);
  if (rotated) refreshSession = rotated;
  sleep(REFRESH_PAUSE_SECONDS);
}

export function walletRequest() {
  if (!walletSession) {
    walletSession = login(userIndexForVu());
    if (!walletSession) return;
  }
  getWallet(walletSession.accessToken);
}

export function weightedApiRequest(setupData) {
  const route = weightedRoute(exec.scenario.iterationInTest);
  let session = null;
  if (route.auth) {
    if (API_SESSION_MODE === 'shared') {
      session = setupData?.apiSession || null;
    } else {
      if (!apiSession) apiSession = login(userIndexForVu());
      session = apiSession;
    }
    if (!session) {
      throw new Error('Authenticated API request has no session.');
    }
  }

  const headers = route.auth ? authHeaders(session.accessToken) : baseHeaders();
  const response = http.get(`${API_BASE}${route.path}`, {
    headers,
    tags: { endpoint: route.name, kind: 'app' },
    timeout: '15s',
  });
  record(response, [200], route.name, appRequestDuration);
  if (route.name === 'store.wallet') walletDuration.add(response.timings.duration);
}

export function signupArrival() {
  const sequence = SHARD_START + exec.scenario.iterationInTest;
  const email = `${__ENV.SIGNUP_EMAIL_PREFIX || 'load'}+${signupRunId()}-${sequence}@${__ENV.SIGNUP_EMAIL_DOMAIN}`;
  const response = http.post(`${API_BASE}/api/v1/auth/register`, JSON.stringify({
    email,
    password: PASSWORD,
    locale: 'en',
  }), {
    headers: jsonHeaders(),
    tags: { endpoint: 'auth.signup', kind: 'auth' },
    timeout: '15s',
  });
  record(response, [201], 'auth.signup', signupDuration);
}

function login(userIndex) {
  const response = http.post(`${API_BASE}/api/v1/auth/login`, JSON.stringify({
    email: userEmail(userIndex),
    password: PASSWORD,
  }), {
    headers: jsonHeaders(),
    tags: { endpoint: 'auth.login', kind: 'auth' },
    timeout: '15s',
  });
  const ok = record(response, [200], 'auth.login', loginDuration);
  if (!ok) return null;
  const body = jsonBody(response);
  const accessToken = typeof body?.access_token === 'string' ? body.access_token : null;
  const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token : null;
  const hasToken = Boolean(accessToken);
  failCheck('auth.login returned access token', hasToken);
  return hasToken ? { accessToken, refreshToken } : null;
}

function refresh(refreshToken) {
  const response = http.post(`${API_BASE}/api/v1/auth/refresh`, JSON.stringify({
    refresh_token: refreshToken,
  }), {
    headers: jsonHeaders(),
    tags: { endpoint: 'auth.refresh', kind: 'auth' },
    timeout: '15s',
  });
  const ok = record(response, [200], 'auth.refresh', refreshDuration);
  if (!ok) return null;
  const body = jsonBody(response);
  const accessToken = typeof body?.access_token === 'string' ? body.access_token : null;
  const nextRefreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token : null;
  const hasRotatedSession = Boolean(accessToken && nextRefreshToken);
  failCheck('auth.refresh returned rotated session', hasRotatedSession);
  return hasRotatedSession ? { accessToken, refreshToken: nextRefreshToken } : null;
}

function getWallet(accessToken) {
  const response = getAuthenticated('/api/v1/store/wallet', accessToken, 'store.wallet');
  walletDuration.add(response.timings.duration);
  return response;
}

function getAuthenticated(path, accessToken, endpoint) {
  const response = http.get(`${API_BASE}${path}`, {
    headers: authHeaders(accessToken),
    tags: { endpoint, kind: 'app' },
    timeout: '15s',
  });
  record(response, [200], endpoint, appRequestDuration);
  return response;
}

function record(response, expectedStatuses, label, trend) {
  trend.add(response.timings.duration);
  const ok = expectedStatuses.includes(response.status);
  if (response.status === 429) {
    rateLimitedResponses.add(1);
    if (label === 'auth.login') loginRateLimited.add(1);
    else if (label === 'auth.refresh') refreshRateLimited.add(1);
    else if (label === 'auth.signup') signupRateLimited.add(1);
    const source = rateLimitSource(response);
    if (source === 'supabase_auth') supabaseAuthRateLimited.add(1);
    else if (source === 'application') applicationRateLimited.add(1);
    else unknownRateLimited.add(1);
  }
  if (response.status >= 500 || response.status === 0) serverErrorResponses.add(1);
  unexpectedFailures.add(!ok);
  check(response, { [`${label} returned expected status`]: () => ok });
  return ok;
}

function rateLimitSource(response) {
  try {
    const body = response.json();
    if (body?.details?.source === 'supabase_auth') return 'supabase_auth';
    if (body?.code === 'RATE_LIMIT_EXCEEDED') return 'application';
  } catch (_) {
    // A non-JSON proxy response remains visible in the unknown counter.
  }
  return 'unknown';
}

function failCheck(label, ok) {
  unexpectedFailures.add(!ok);
  check(null, { [label]: () => ok });
}

function jsonBody(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function baseHeaders() {
  return BYPASS_TOKEN ? { 'x-chaos-bypass': BYPASS_TOKEN } : {};
}

function jsonHeaders() {
  return { ...baseHeaders(), 'Content-Type': 'application/json' };
}

function authHeaders(accessToken) {
  return { ...baseHeaders(), Authorization: `Bearer ${accessToken}` };
}

function userEmail(index) {
  return `${EMAIL_PREFIX}+u${index}@${EMAIL_DOMAIN}`;
}

function userIndexForVu() {
  return SHARD_START + ((exec.vu.idInTest - 1) % USER_COUNT);
}

function userIndexForArrival() {
  return SHARD_START + (exec.scenario.iterationInTest % USER_COUNT);
}

function weightedRoute(sequence) {
  const total = SAFE_API_ROUTES.reduce((sum, route) => sum + route.weight, 0);
  let slot = sequence % total;
  for (const route of SAFE_API_ROUTES) {
    slot -= route.weight;
    if (slot < 0) return route;
  }
  return SAFE_API_ROUTES[SAFE_API_ROUTES.length - 1];
}

function buildOptions() {
  const thresholds = {
    checks: ['rate>0.99'],
    unexpected_failures: [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '30s' }],
    app_request_duration: ['p(95)<1500', 'p(99)<3000'],
    auth_login_duration: ['p(95)<2000', 'p(99)<4000'],
    auth_refresh_duration: ['p(95)<2000', 'p(99)<4000'],
    auth_signup_duration: ['p(95)<3000', 'p(99)<5000'],
    wallet_duration: ['p(95)<1500', 'p(99)<3000'],
    server_error_responses: ['count==0'],
    dropped_iterations: ['count==0'],
  };

  const commonArrival = {
    executor: 'ramping-arrival-rate',
    startRate: START_RATE,
    timeUnit: TIME_UNIT,
    preAllocatedVUs: PREALLOCATED_VUS,
    maxVUs: MAX_VUS,
    stages: [
      { target: RATE, duration: RAMP_DURATION },
      { target: RATE, duration: DURATION },
      { target: 0, duration: '15s' },
    ],
    gracefulStop: '30s',
  };

  if (MODE === 'smoke') {
    return {
      scenarios: {
        smoke: { executor: 'per-vu-iterations', exec: 'smokeJourney', vus: VUS, iterations: 1, maxDuration: '2m' },
      },
      thresholds,
    };
  }
  if (MODE === 'signup') {
    return { scenarios: { signup: { ...commonArrival, exec: 'signupArrival' } }, thresholds };
  }
  if (MODE === 'login') {
    return { scenarios: { login: { ...commonArrival, exec: 'loginArrival' } }, thresholds };
  }
  if (MODE === 'api') {
    return { scenarios: { api: { ...commonArrival, exec: 'weightedApiRequest' } }, thresholds };
  }
  if (MODE === 'wallet') {
    return { scenarios: { wallet: { ...commonArrival, exec: 'walletRequest' } }, thresholds };
  }
  if (MODE === 'refresh') {
    return {
      scenarios: {
        refresh: { executor: 'constant-vus', exec: 'refreshLoop', vus: VUS, duration: DURATION, gracefulStop: '30s' },
      },
      thresholds,
    };
  }
  if (MODE === 'auth-mix') {
    const loginRate = positiveInt('LOGIN_RATE', Math.max(1, Math.round(RATE * 0.2)));
    const walletRate = positiveInt('WALLET_RATE', Math.max(1, Math.round(RATE * 0.25)));
    return {
      scenarios: {
        login: { ...commonArrival, exec: 'loginArrival', startRate: 0, stages: [{ target: loginRate, duration: RAMP_DURATION }, { target: loginRate, duration: DURATION }] },
        api: { ...commonArrival, exec: 'weightedApiRequest' },
        wallet: { ...commonArrival, exec: 'walletRequest', startRate: 0, stages: [{ target: walletRate, duration: RAMP_DURATION }, { target: walletRate, duration: DURATION }] },
        refresh: { executor: 'constant-vus', exec: 'refreshLoop', vus: VUS, duration: DURATION, startTime: RAMP_DURATION, gracefulStop: '30s' },
      },
      thresholds,
    };
  }
  throw new Error(`Unsupported MODE=${MODE}. Use smoke, signup, login, refresh, wallet, api, or auth-mix.`);
}

function assertSafeConfiguration() {
  const lower = API_BASE.toLowerCase();
  if (lower.includes('api.quizball.io') || lower.includes('lfbwhxvwubzeqkztghok')) {
    throw new Error(`PROD GUARD: refusing k6 target ${API_BASE}`);
  }
  if (TARGET === 'staging' && API_BASE !== 'https://api-staging.quizball.io') {
    throw new Error(`PROD GUARD: staging must use https://api-staging.quizball.io, got ${API_BASE}`);
  }
  if (TARGET === 'local' && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(API_BASE)) {
    throw new Error(`PROD GUARD: local target must be loopback, got ${API_BASE}`);
  }
  if (VUS > USER_COUNT && ['smoke', 'refresh', 'wallet', 'auth-mix'].includes(MODE)) {
    throw new Error(`VUS (${VUS}) cannot exceed unique USERS (${USER_COUNT}) for MODE=${MODE}.`);
  }
  if (MAX_VUS < PREALLOCATED_VUS) {
    throw new Error(`MAX_VUS (${MAX_VUS}) cannot be lower than PREALLOCATED_VUS (${PREALLOCATED_VUS}).`);
  }
  if (!['shared', 'per-vu'].includes(API_SESSION_MODE)) {
    throw new Error(`API_SESSION_MODE must be shared or per-vu, got ${API_SESSION_MODE}.`);
  }
  if (API_SESSION_MODE === 'shared' && ['api', 'auth-mix'].includes(MODE)) {
    const plannedSeconds = durationSeconds(RAMP_DURATION, true) + durationSeconds(DURATION) + 45;
    if (plannedSeconds > SHARED_SESSION_TTL_SECONDS - SHARED_SESSION_SAFETY_SECONDS) {
      throw new Error(
        `Shared API session would outlive its JWT: planned ${plannedSeconds}s exceeds `
        + `${SHARED_SESSION_TTL_SECONDS - SHARED_SESSION_SAFETY_SECONDS}s. `
        + 'Shorten the run or use API_SESSION_MODE=per-vu.'
      );
    }
  }
  if (MODE === 'signup') {
    if (__ENV.ALLOW_SIGNUP_LOAD !== 'STAGING_EMAIL_SINK_CONFIGURED') {
      throw new Error('Signup load is blocked. Set ALLOW_SIGNUP_LOAD=STAGING_EMAIL_SINK_CONFIGURED only on a dedicated Auth project with an email sink.');
    }
    if (!__ENV.SIGNUP_EMAIL_DOMAIN || !__ENV.SIGNUP_RUN_ID) {
      throw new Error('Signup load requires SIGNUP_EMAIL_DOMAIN and unique SIGNUP_RUN_ID.');
    }
  }
}

function signupRunId() {
  return String(__ENV.SIGNUP_RUN_ID).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function positiveInt(name, fallback) {
  const value = __ENV[name] === undefined ? fallback : Number(__ENV[name]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeInt(name, fallback) {
  const value = __ENV[name] === undefined ? fallback : Number(__ENV[name]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function positiveNumber(name, fallback) {
  const value = __ENV[name] === undefined ? fallback : Number(__ENV[name]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function durationSeconds(raw, allowZero = false) {
  const source = String(raw).trim();
  const unitSeconds = { ms: 0.001, s: 1, m: 60, h: 3_600 };
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let consumed = '';
  let match;
  while ((match = pattern.exec(source)) !== null) {
    total += Number(match[1]) * unitSeconds[match[2]];
    consumed += match[0];
  }
  if (
    !Number.isFinite(total)
    || total < 0
    || (!allowZero && total === 0)
    || consumed !== source
  ) {
    throw new Error(`Invalid k6 duration: ${source}`);
  }
  return total;
}
