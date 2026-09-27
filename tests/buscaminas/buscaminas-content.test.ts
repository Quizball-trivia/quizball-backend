import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createContentLoader } from '../../src/modules/buscaminas/buscaminas.content.js';
import { LAUNCH_DAY, PUBLISHED_DAYS } from '../../src/modules/buscaminas/buscaminas.days.js';
import { openContent, sealContent, type SealedContent } from '../../src/modules/buscaminas/buscaminas.sealed.js';
import { createBuscaminasService } from '../../src/modules/buscaminas/buscaminas.service.js';
import { memoryRunLedger, memoryStartCounter } from '../../src/modules/buscaminas/buscaminas.ledger.js';
import { newPayload } from '../../src/modules/buscaminas/buscaminas.rules.js';
import { signToken } from '../../src/modules/buscaminas/buscaminas.token.js';
import type { BuscaminasDayContent } from '../../src/modules/buscaminas/buscaminas.types.js';
import { calendar, makeDay, testKey } from './fixtures.js';

const contentDir = join(__dirname, '../../src/modules/buscaminas/content');
const DAYS = calendar(11);
const disabled = { statusCode: 503, message: 'Buscaminas is currently disabled' };

const flipFirstByte = (b64: string): string => {
  const bytes = Buffer.from(b64, 'base64');
  bytes[0] ^= 1;
  return bytes.toString('base64');
};

function loader(sealed: SealedContent, key: string | undefined) {
  const source = vi.fn(async () => sealed);
  return { ...createContentLoader({ sealed: source, key: () => key }), source };
}

describe('buscaminas sealed content', () => {
  it('ships only the encrypted artifact, as a well-formed AES-256-GCM envelope', async () => {
    expect(readdirSync(contentDir)).toEqual(['content.enc.ts']);
    expect(readFileSync(join(contentDir, 'content.enc.ts'), 'utf8')).not.toMatch(/"ok"|"cards"|"rounds"/);
    const { BUSCAMINAS_SEALED_CONTENT: sealed } = await import('../../src/modules/buscaminas/content/content.enc.js');
    expect(sealed).toMatchObject({ v: 1, alg: 'aes-256-gcm' });
    expect(Buffer.from(sealed.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(sealed.tag, 'base64')).toHaveLength(16);
    expect(Buffer.from(sealed.data, 'base64').length).toBeGreaterThan(0);
  });

  it('round-trips the minimal answer shape and hides it from the ciphertext', () => {
    const key = testKey();
    const two = DAYS.slice(0, 2);
    const withExtras = two.map((d) => ({ ...d, rounds: d.rounds.map((r) => ({ ...r, prompt: 'p', cards: r.cards.map((c) => ({ ...c, name: 'n', img: 'i' })) })) }));
    const sealed = sealContent(withExtras, key);
    expect(JSON.stringify(sealed)).not.toMatch(/r0c0|"ok"/);
    expect(openContent(sealed, key)).toEqual(two);
    expect(sealContent(two, key).iv).not.toBe(sealed.iv);
  });

  it('decrypts once and indexes the whole calendar', async () => {
    const key = testKey();
    const { load, check, source } = loader(sealContent(DAYS, key), key);
    const [a, b] = await Promise.all([load(), load()]);
    expect(a).toBe(b);
    expect(await load()).toBe(a);
    expect(a.size).toBe(PUBLISHED_DAYS);
    expect([...a.keys()].slice(0, 2)).toEqual([LAUNCH_DAY, '2026-09-27']);
    expect(a.get('2026-09-27')).toMatchObject({ contentVersion: 12 });
    expect(a.get(LAUNCH_DAY)!.rounds[0].okIds.has('r0c0')).toBe(true);
    expect(await check()).toEqual({ ok: true, days: PUBLISHED_DAYS });
    expect(source).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a missing key', (s: SealedContent) => s, () => undefined, /BUSCAMINAS_CONTENT_KEY is not set/],
    ['a malformed key', (s: SealedContent) => s, () => 'abc', /64 hex/],
    ['the wrong key', (s: SealedContent) => s, () => testKey(), /decryption failed/],
    ['tampered ciphertext', (s: SealedContent) => ({ ...s, data: flipFirstByte(s.data) }), null, /decryption failed/],
    ['a tampered auth tag', (s: SealedContent) => ({ ...s, tag: flipFirstByte(s.tag) }), null, /decryption failed/],
    ['a truncated iv', (s: SealedContent) => ({ ...s, iv: s.iv.slice(0, 8) }), null, /malformed/],
    ['an unknown envelope version', (s: SealedContent) => ({ ...s, v: 2 }) as unknown as SealedContent, null, /unsupported/],
  ])('is disabled (503, one attempt, reason without key material) with %s', async (_name, mutate, keyFor, reason) => {
    const key = testKey();
    const given = keyFor ? keyFor() : key;
    const { load, check, source } = loader(mutate(sealContent(DAYS.slice(0, 1), key)), given);
    await expect(load()).rejects.toMatchObject(disabled);
    await expect(load()).rejects.toMatchObject(disabled);
    const result = await check();
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
    expect(JSON.stringify(result)).not.toContain(key);
    if (given) expect(JSON.stringify(result)).not.toContain(given);
    expect(source.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('rejects decrypted content that fails validation', async () => {
    const key = testKey();
    const broken = DAYS.map((d, i) => (i === 0 ? { ...d, rounds: d.rounds.map((r, j) => (j === 0 ? { ...r, cards: r.cards.map((c) => ({ ...c, ok: true })) } : r)) } : d));
    const { load, check } = loader(sealContent(broken, key), key);
    await expect(load()).rejects.toMatchObject(disabled);
    expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/expected 12 correct cards/) });
  });

  it.each<[string, (days: BuscaminasDayContent[]) => BuscaminasDayContent[], RegExp]>([
    ['the current 30-day artifact shape', (d) => d.slice(0, 30), new RegExp(`expected ${PUBLISHED_DAYS} days from ${LAUNCH_DAY}, found 30`)],
    ['one day too many', (d) => [...d, makeDay('2026-12-25')], new RegExp(`found ${PUBLISHED_DAYS + 1}`)],
    ['a calendar not starting at launch', (d) => [makeDay('2026-09-25'), ...d.slice(0, -1)], /contiguous from 2026-09-26: position 1 is 2026-09-25/],
    ['a gap', (d) => [...d.slice(0, 5), ...d.slice(6), makeDay('2026-12-25')], /position 6 is 2026-10-02, expected 2026-10-01/],
    ['a day numbered out of position', (d) => d.map((x, i) => (i === 3 ? { ...x, number: 7 } : x)), /2026-09-29: number must be 4, found 7/],
  ])('rejects %s', async (_name, mutate, reason) => {
    const key = testKey();
    const { load, check } = loader(sealContent(mutate(calendar()), key), key);
    await expect(load()).rejects.toMatchObject(disabled);
    expect(await check()).toEqual({ ok: false, reason: expect.stringMatching(reason) });
  });

  it('every endpoint (start/tap/bank/next/current/leaderboard) answers 503 while the content cannot be decrypted', async () => {
    const key = testKey();
    const secret = 's'.repeat(64);
    const { load } = loader(sealContent(DAYS, key), testKey());
    // A user with no run: /current must still check the content instead of answering { run: null }.
    const repo = { getRun: async () => null } as unknown as Parameters<typeof createBuscaminasService>[0]['repo'];
    const svc = createBuscaminasService({
      repo, ledger: memoryRunLedger(), starts: memoryStartCounter(), guestsPlayLive: () => false, liveStartsPerDay: () => 8,
      content: load, secret: () => secret, now: () => new Date('2026-09-27T15:00:00Z'),
    });
    const iat = Math.floor(Date.parse('2026-09-27T15:00:00Z') / 1000);
    const token = signToken(newPayload('rid', '2026-09-27', 12, null), secret, { iat, exp: iat + 60 });
    await expect(svc.start('2026-09-27', null)).rejects.toMatchObject(disabled);
    await expect(svc.tap(token, 'r0c0', null)).rejects.toMatchObject(disabled);
    await expect(svc.bank(token, null)).rejects.toMatchObject(disabled);
    await expect(svc.next(token, null)).rejects.toMatchObject(disabled);
    await expect(svc.current('user-a', undefined)).rejects.toMatchObject(disabled);
    await expect(svc.current('user-a', '2026-09-27')).rejects.toMatchObject(disabled);
    await expect(svc.leaderboard(undefined, null)).rejects.toMatchObject(disabled);
  });
});
