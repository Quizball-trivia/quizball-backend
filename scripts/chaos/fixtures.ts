import type { ChaosUser } from './auth.js';
import type { ChaosRouteFixtures } from './routes.js';

interface FixtureResponse {
  data?: unknown[];
  items?: unknown[];
}

function firstId(payload: unknown): string | null {
  const candidates = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? ((payload as FixtureResponse).data ?? (payload as FixtureResponse).items ?? [])
      : [];
  const id = (candidates[0] as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

async function fetchFixture(
  apiBase: string,
  endpointPath: string,
  user: ChaosUser,
  bypassToken?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (user.token) headers.Authorization = `Bearer ${user.token}`;
  if (bypassToken) headers['x-chaos-bypass'] = bypassToken;
  const response = await fetch(`${apiBase}${endpointPath}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Fixture discovery ${endpointPath} returned ${response.status}`);
  }
  return response.json();
}

export async function discoverRouteFixtures(
  apiBase: string,
  user: ChaosUser,
  bypassToken?: string,
): Promise<ChaosRouteFixtures> {
  const [categories, questions, featured] = await Promise.all([
    fetchFixture(apiBase, '/api/v1/categories?limit=1&is_active=true&page=1', user, bypassToken),
    fetchFixture(apiBase, '/api/v1/questions?limit=1&page=1&status=published', user, bypassToken),
    fetchFixture(apiBase, '/api/v1/featured-categories', user, bypassToken),
  ]);
  const categoryId = firstId(categories);
  const questionId = firstId(questions);
  const featuredCategoryId = firstId(featured);
  if (!categoryId || !questionId || !featuredCategoryId) {
    throw new Error(
      `Fixture discovery incomplete: category=${Boolean(categoryId)} question=${Boolean(questionId)} featured=${Boolean(featuredCategoryId)}`
    );
  }
  return { categoryId, questionId, featuredCategoryId };
}
