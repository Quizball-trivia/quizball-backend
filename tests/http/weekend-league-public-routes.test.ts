import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 2026-09-25: /hall-of-fame sat behind the blanket authMiddleware while its
// handler never read the caller, so every logged-out Weekend League visitor
// got a 401 and an empty board (275 errors / 115 users in 6h). Keep it public.
const routes = readFileSync(
  resolve(__dirname, '../../src/http/routes/weekend-league.routes.ts'), 'utf8');
const controller = readFileSync(
  resolve(__dirname, '../../src/modules/weekend-league/weekend-league.controller.ts'), 'utf8');

describe('weekend-league route auth', () => {
  it('registers /hall-of-fame with optional auth BEFORE the blanket authMiddleware', () => {
    const hofIdx = routes.indexOf("router.get('/hall-of-fame'");
    const blanketIdx = routes.indexOf('router.use(authMiddleware)');
    expect(hofIdx).toBeGreaterThan(-1);
    expect(blanketIdx).toBeGreaterThan(-1);
    expect(hofIdx).toBeLessThan(blanketIdx);
    expect(routes).toContain("router.get('/hall-of-fame', optionalAuthMiddleware");
  });

  it('does not require a user id in the hallOfFame handler', () => {
    const body = controller.slice(controller.indexOf('async hallOfFame'));
    const handler = body.slice(0, body.indexOf('},') + 2);
    expect(handler).not.toContain('requireUserId');
  });

  it('keeps the personalised endpoints authenticated', () => {
    const blanketIdx = routes.indexOf('router.use(authMiddleware)');
    const after = routes.slice(blanketIdx);
    for (const path of ['/current', '/qp', '/standings', '/enter', '/checkin']) {
      expect(after).toContain(`'${path}'`);
    }
  });
});
