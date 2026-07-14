// Route catalog for the chaos harness. Each entry is one endpoint the harness
// can drive at a target RPS. `auth` decides whether a bearer token is attached.
// `mutates` flags state-changing routes — these are gated to non-prod targets.
// `weight` lets the mixed-traffic mode bias toward hot paths.

export type RouteAuth = 'none' | 'bearer';

export interface ChaosRoute {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  // Path under the API base. `{userId}` is substituted with the caller's own id.
  path: string;
  auth: RouteAuth;
  mutates: boolean;
  // Static or per-call JSON body. A function receives the caller context.
  body?: (ctx: RouteBodyContext) => unknown;
  // Query string appended verbatim (already URL-encoded).
  query?: string;
  weight: number;
  // Routes a real client hammers during normal play vs. economy/social writes.
  group: 'public-read' | 'auth-read' | 'economy-write' | 'social-write' | 'session-write';
}

export interface RouteBodyContext {
  userId: string;
  email: string;
}

const KNOWN_CHALLENGE = 'countdown';

export const CHAOS_ROUTES: ChaosRoute[] = [
  // ── Public reads (no token) — the unauthenticated browse surface ──────────
  { name: 'categories.list', method: 'GET', path: '/api/v1/categories', query: 'limit=100&is_active=true&page=1', auth: 'none', mutates: false, weight: 6, group: 'public-read' },
  { name: 'categories.list.minq', method: 'GET', path: '/api/v1/categories', query: 'limit=100&is_active=true&min_questions=5', auth: 'none', mutates: false, weight: 4, group: 'public-read' },
  { name: 'questions.list', method: 'GET', path: '/api/v1/questions', query: 'limit=50&page=1', auth: 'none', mutates: false, weight: 5, group: 'public-read' },
  { name: 'featured.list', method: 'GET', path: '/api/v1/featured-categories', auth: 'none', mutates: false, weight: 3, group: 'public-read' },
  { name: 'store.products', method: 'GET', path: '/api/v1/store/products', auth: 'none', mutates: false, weight: 3, group: 'public-read' },

  // ── Authenticated reads — the hot client polling set during play/menus ────
  { name: 'users.me', method: 'GET', path: '/api/v1/users/me', auth: 'bearer', mutates: false, weight: 6, group: 'auth-read' },
  { name: 'users.me.achievements', method: 'GET', path: '/api/v1/users/me/achievements', auth: 'bearer', mutates: false, weight: 2, group: 'auth-read' },
  { name: 'ranked.profile', method: 'GET', path: '/api/v1/ranked/profile', auth: 'bearer', mutates: false, weight: 5, group: 'auth-read' },
  { name: 'ranked.leaderboard.global', method: 'GET', path: '/api/v1/ranked/leaderboard', query: 'scope=global&limit=50&offset=0', auth: 'bearer', mutates: false, weight: 5, group: 'auth-read' },
  { name: 'ranked.leaderboard.country', method: 'GET', path: '/api/v1/ranked/leaderboard', query: 'scope=country&limit=50&offset=0', auth: 'bearer', mutates: false, weight: 4, group: 'auth-read' },
  { name: 'ranked.leaderboard.me', method: 'GET', path: '/api/v1/ranked/leaderboard/me', query: 'scope=global', auth: 'bearer', mutates: false, weight: 4, group: 'auth-read' },
  { name: 'stats.summary', method: 'GET', path: '/api/v1/stats/summary', auth: 'bearer', mutates: false, weight: 4, group: 'auth-read' },
  { name: 'stats.recent', method: 'GET', path: '/api/v1/stats/recent-matches', query: 'limit=10', auth: 'bearer', mutates: false, weight: 4, group: 'auth-read' },
  { name: 'store.wallet', method: 'GET', path: '/api/v1/store/wallet', auth: 'bearer', mutates: false, weight: 4, group: 'auth-read' },
  { name: 'store.inventory', method: 'GET', path: '/api/v1/store/inventory', auth: 'bearer', mutates: false, weight: 3, group: 'auth-read' },
  { name: 'daily.list', method: 'GET', path: '/api/v1/daily-challenges', auth: 'bearer', mutates: false, weight: 4, group: 'auth-read' },
  { name: 'objectives.list', method: 'GET', path: '/api/v1/objectives', auth: 'bearer', mutates: false, weight: 3, group: 'auth-read' },
  { name: 'lobbies.public', method: 'GET', path: '/api/v1/lobbies/public', auth: 'bearer', mutates: false, weight: 3, group: 'auth-read' },
  { name: 'friends.list', method: 'GET', path: '/api/v1/friends', auth: 'bearer', mutates: false, weight: 2, group: 'auth-read' },
  { name: 'friends.requests', method: 'GET', path: '/api/v1/friends/requests', auth: 'bearer', mutates: false, weight: 2, group: 'auth-read' },

  // ── Mutations (non-prod only) — economy / session / presence writes ───────
  {
    name: 'daily.session',
    method: 'POST',
    path: `/api/v1/daily-challenges/${KNOWN_CHALLENGE}/session`,
    auth: 'bearer',
    mutates: true,
    weight: 2,
    group: 'session-write',
  },
  {
    name: 'users.me.update',
    method: 'PUT',
    path: '/api/v1/users/me',
    auth: 'bearer',
    mutates: true,
    weight: 1,
    group: 'social-write',
    // No-op-ish profile write: re-set the locale, which always validates.
    body: () => ({ language: 'en' }),
  },
];

// Mutating routes that are SAFE to fire repeatedly (idempotent-ish / reversible)
// vs. ones that drain limited resources (tickets/coins) and should be sampled
// at low rate. purchase-coins and daily/complete are deliberately omitted from
// the default catalog to avoid bankrupting test wallets in seconds; they can be
// enabled explicitly with --include-spend.
export const SPEND_ROUTES: ChaosRoute[] = [
  {
    name: 'daily.complete',
    method: 'POST',
    path: `/api/v1/daily-challenges/${KNOWN_CHALLENGE}/complete`,
    auth: 'bearer',
    mutates: true,
    weight: 1,
    group: 'economy-write',
    body: () => ({ score: 1, correctAnswers: 1, durationMs: 5000 }),
  },
];
