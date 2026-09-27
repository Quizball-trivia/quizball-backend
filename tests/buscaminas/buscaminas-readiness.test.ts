import { describe, expect, it, vi } from 'vitest';
import { createContentLoader } from '../../src/modules/buscaminas/buscaminas.content.js';
import { PUBLISHED_DAYS } from '../../src/modules/buscaminas/buscaminas.days.js';
import { checkBuscaminasReadiness, tokenSecretProblem, usableTokenSecret } from '../../src/modules/buscaminas/buscaminas.readiness.js';
import { sealContent } from '../../src/modules/buscaminas/buscaminas.sealed.js';
import { calendar, testKey } from './fixtures.js';

const SECRET = 't'.repeat(40);

function run(opts: { enabled?: boolean; secret?: string; key?: string; sealedKey?: string; days?: number }) {
  const sealedKey = opts.sealedKey ?? testKey();
  const sealed = sealContent(calendar().slice(0, opts.days ?? PUBLISHED_DAYS), sealedKey);
  const content = createContentLoader({ sealed: async () => sealed, key: () => ('key' in opts ? opts.key : sealedKey) });
  const log = { error: vi.fn(), info: vi.fn() };
  const done = checkBuscaminasReadiness({ enabled: opts.enabled ?? true, tokenSecret: 'secret' in opts ? opts.secret : SECRET, content, log });
  return { done, log, content, sealedKey };
}

describe('buscaminas boot readiness', () => {
  it('does nothing while disabled', async () => {
    const { done, log } = run({ enabled: false, secret: undefined, key: undefined });
    expect(await done).toEqual({ ready: false, problems: [] });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('decrypts eagerly and logs ready once when everything is in place', async () => {
    const { done, log, content } = run({});
    expect(await done).toEqual({ ready: true, problems: [] });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ days: PUBLISHED_DAYS }, 'Buscaminas ready');
    expect((await content.load()).size).toBe(PUBLISHED_DAYS);
  });

  it('logs ONE error naming every problem, without key material', async () => {
    const wrongKey = testKey();
    const { done, log, sealedKey } = run({ secret: undefined, key: wrongKey });
    const result = await done;
    expect(result.ready).toBe(false);
    expect(result.problems).toEqual(['BUSCAMINAS_TOKEN_SECRET is not set', expect.stringMatching(/^content: decryption failed: wrong BUSCAMINAS_CONTENT_KEY/)]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
    const logged = JSON.stringify(log.error.mock.calls[0]);
    expect(logged).toMatch(/BUSCAMINAS_TOKEN_SECRET is not set.*decryption failed/);
    expect(logged).not.toContain(wrongKey);
    expect(logged).not.toContain(sealedKey);
  });

  it.each([
    ['a short secret', { secret: 'short' }, /BUSCAMINAS_TOKEN_SECRET must be at least 32 characters/],
    ['a missing content key', { key: undefined }, /content: BUSCAMINAS_CONTENT_KEY is not set/],
    ['a malformed content key', { key: 'not-hex' }, /content: BUSCAMINAS_CONTENT_KEY must be 64 hex characters/],
    ['a short calendar', { days: 30 }, new RegExp(`content: expected ${PUBLISHED_DAYS} days from 2026-09-26, found 30`)],
  ])('%s is one clear error', async (_name, opts, message) => {
    const { done, log } = run(opts);
    expect((await done).ready).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][1]).toMatch(message);
    expect(log.error.mock.calls[0][1]).not.toContain('not-hex');
  });

  it('never throws, even if the content check itself blows up', async () => {
    const log = { error: vi.fn(), info: vi.fn() };
    const result = await checkBuscaminasReadiness({ enabled: true, tokenSecret: SECRET, content: { check: async () => { throw new Error('boom'); } }, log });
    expect(result).toEqual({ ready: false, problems: ['readiness check failed: boom'] });
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('a short or missing token secret keeps the module disabled', () => {
    expect(tokenSecretProblem(undefined)).toMatch(/not set/);
    expect(usableTokenSecret('x'.repeat(31))).toBeUndefined();
    expect(usableTokenSecret(SECRET)).toBe(SECRET);
  });
});
