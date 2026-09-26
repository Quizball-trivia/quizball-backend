import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 2026-09-26: /lobbies/public sat behind the blanket authMiddleware while its
// handler reads no caller — 189 401s/day from logged-out visitors. Same class
// as the hall-of-fame fix (#745). Keep it public.
const routes = readFileSync(
  resolve(__dirname, '../../src/http/routes/lobbies.routes.ts'), 'utf8');

describe('lobbies route auth', () => {
  it('registers /public with optional auth BEFORE the blanket authMiddleware', () => {
    const pubIdx = routes.indexOf("router.get(\n  '/public'");
    const blanketIdx = routes.indexOf('router.use(authMiddleware)');
    expect(pubIdx).toBeGreaterThan(-1);
    expect(blanketIdx).toBeGreaterThan(-1);
    expect(pubIdx).toBeLessThan(blanketIdx);
    expect(routes).toContain('optionalAuthMiddleware');
  });
});
