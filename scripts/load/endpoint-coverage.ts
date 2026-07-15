import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { generateOpenApiDocument } from '../../src/http/openapi/index.js';
import { CHAOS_ROUTES, SPEND_ROUTES } from '../chaos/routes.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Treatment = 'scale' | 'auth-scale' | 'realistic-write' | 'controlled' | 'stubbed' | 'smoke';

interface Endpoint {
  method: Method;
  path: string;
  source: string;
  treatment: Treatment;
  driver: string;
  documented: boolean;
}

const root = process.cwd();
const routesIndex = path.join(root, 'src/http/routes/index.ts');
const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

function importedRouteFiles(index: ts.SourceFile): Map<string, string> {
  const imports = new Map<string, string>();
  for (const statement of index.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const modulePath = statement.moduleSpecifier.text;
    if (!modulePath.startsWith('./') || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    const resolved = path.resolve(path.dirname(routesIndex), modulePath.replace(/\.js$/, '.ts'));
    for (const element of statement.importClause.namedBindings.elements) {
      imports.set(element.name.text, resolved);
    }
  }
  return imports;
}

function mountedRouters(index: ts.SourceFile, imports: Map<string, string>): Array<{ prefix: string; file: string }> {
  const mounted: Array<{ prefix: string; file: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(index) === 'router'
      && node.expression.name.text === 'use') {
      const args = [...node.arguments];
      const prefix = ts.isStringLiteral(args[0]) ? args.shift()!.text : '';
      const routeIdentifier = args.find(ts.isIdentifier);
      if (routeIdentifier) {
        const file = imports.get(routeIdentifier.text);
        if (file?.endsWith('.routes.ts')) mounted.push({ prefix, file });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(index);
  return mounted;
}

function routesInFile(file: string, prefix: string): Array<{ method: Method; path: string; source: string }> {
  const source = parse(file);
  const found: Array<{ method: Method; path: string; source: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === 'router'
      && methods.has(node.expression.name.text)
      && ts.isStringLiteral(node.arguments[0])) {
      const suffix = node.arguments[0].text === '/' ? '' : node.arguments[0].text;
      found.push({
        method: node.expression.name.text.toUpperCase() as Method,
        path: `${prefix}${suffix}` || '/',
        source: path.relative(root, file),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function normalize(value: string): string {
  return value
    .split('?')[0]!
    .replace(/\{[^/]+\}/g, ':param')
    .replace(/:[^/]+/g, ':param')
    .replace(/\/$/, '') || '/';
}

function key(method: string, endpointPath: string): string {
  return `${method.toUpperCase()} ${normalize(endpointPath)}`;
}

const functionRouteAliases: Record<string, string> = {
  'categories.detail': '/api/v1/categories/:id',
  'categories.dependencies': '/api/v1/categories/:id/dependencies',
  'questions.detail': '/api/v1/questions/:id',
  'featured.detail': '/api/v1/featured-categories/:id',
};
const chaosKeys = new Set([...CHAOS_ROUTES, ...SPEND_ROUTES].map((route) => key(
  route.method,
  typeof route.path === 'function' ? functionRouteAliases[route.name] ?? route.name : route.path,
)));
chaosKeys.add('POST /api/v1/daily-challenges/:param/session');
chaosKeys.add('POST /api/v1/daily-challenges/:param/complete');

const k6Paths = [
  '/api/v1/categories', '/api/v1/questions', '/api/v1/featured-categories', '/api/v1/store/products',
  '/api/v1/users/me', '/api/v1/users/me/achievements', '/api/v1/ranked/profile',
  '/api/v1/ranked/leaderboard', '/api/v1/ranked/leaderboard/me', '/api/v1/stats/summary',
  '/api/v1/stats/recent-matches', '/api/v1/store/wallet', '/api/v1/store/inventory',
  '/api/v1/daily-challenges', '/api/v1/objectives', '/api/v1/lobbies/public', '/api/v1/friends',
  '/api/v1/friends/requests', '/api/v1/announcements', '/api/v1/notifications',
  '/api/v1/notifications/unread-count', '/api/v1/users/search',
];
const k6Keys = new Set(k6Paths.map((endpointPath) => key('GET', endpointPath)));
for (const endpointPath of ['/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/auth/refresh']) {
  k6Keys.add(key('POST', endpointPath));
}

function treatment(method: Method, endpointPath: string): Treatment {
  if (endpointPath === '/health' || endpointPath === '/health/db') return 'smoke';
  if (/^\/api\/v1\/auth\/(login|refresh|register)$/.test(endpointPath) && method === 'POST') return 'auth-scale';
  if (/^\/api\/v1\/(internal\/ops|feedback)/.test(endpointPath)
    || /^\/api\/v1\/admin\/translation/.test(endpointPath)
    || /^\/api\/v1\/auth\/(forgot-password|reset-password|phone|sms|social-login)/.test(endpointPath)
    || endpointPath === '/api/v1/store/checkout'
    || /\/translate\//.test(endpointPath)
    || /\/image-mcq\//.test(endpointPath)) return 'stubbed';
  if (endpointPath.startsWith('/api/v1/admin/') || endpointPath.includes('/dev/')
    || endpointPath.includes('/sync-staging') || endpointPath === '/api/v1/users/me/deletion'
    || endpointPath === '/api/v1/questions/duplicates'
    || endpointPath.startsWith('/api/v1/store/admin/')) return 'controlled';
  if (method === 'GET') return 'scale';
  if (/^\/api\/v1\/(daily-challenges|friends|notifications|store\/purchase-coins|users\/me)/.test(endpointPath)) {
    return 'realistic-write';
  }
  return 'controlled';
}

const index = parse(routesIndex);
const actual = mountedRouters(index, importedRouteFiles(index))
  .flatMap(({ prefix, file }) => routesInFile(file, prefix));
const openApi = generateOpenApiDocument();
const documentedKeys = new Set<string>();
for (const [endpointPath, pathItem] of Object.entries(openApi.paths ?? {})) {
  for (const method of methods) {
    if ((pathItem as Record<string, unknown>)[method]) documentedKeys.add(key(method, endpointPath));
  }
}

const endpoints: Endpoint[] = actual.map((route) => {
  const endpointKey = key(route.method, route.path);
  const drivers = [chaosKeys.has(endpointKey) ? 'chaos' : '', k6Keys.has(endpointKey) ? 'k6' : ''].filter(Boolean);
  return {
    ...route,
    treatment: treatment(route.method, route.path),
    driver: drivers.join('+') || 'controlled/manual',
    documented: documentedKeys.has(endpointKey),
  };
}).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const summary = endpoints.reduce<Record<string, number>>((acc, endpoint) => {
  acc[endpoint.treatment] = (acc[endpoint.treatment] ?? 0) + 1;
  return acc;
}, {});
const missingScaleDrivers = endpoints.filter((endpoint) =>
  ['scale', 'auth-scale'].includes(endpoint.treatment)
  && endpoint.driver === 'controlled/manual'
);
const undocumented = endpoints.filter((endpoint) => !endpoint.documented);

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  totalActualHttpOperations: endpoints.length,
  treatmentCounts: summary,
  missingScaleDrivers,
  undocumentedActualRoutes: undocumented,
  endpoints,
}, null, 2));

if (process.argv.includes('--check') && missingScaleDrivers.length > 0) {
  console.error(`Coverage check failed: ${missingScaleDrivers.length} scale/realistic operations lack a driver.`);
  process.exitCode = 1;
}
