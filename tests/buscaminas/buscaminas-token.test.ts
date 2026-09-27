import { describe, expect, it } from 'vitest';
import { signToken, verifyToken } from '../../src/modules/buscaminas/buscaminas.token.js';
import { newPayload } from '../../src/modules/buscaminas/buscaminas.rules.js';

const SECRET = 'a'.repeat(64);
const payload = newPayload('rid-1', '2026-09-27', 1, null);

const expectInvalid = (fn: () => unknown) => expect(fn).toThrowError(expect.objectContaining({ statusCode: 400, message: 'invalid_token' }));

describe('buscaminas run token', () => {
  it('round-trips a signed payload, with and without iat/exp claims', () => {
    const token = signToken(payload, SECRET);
    expect(token.split('.')).toHaveLength(2);
    expect(verifyToken(token, SECRET)).toEqual({ payload, claims: null });
    const claimed = signToken(payload, SECRET, { iat: 1_000, exp: 94_600 });
    expect(verifyToken(claimed, SECRET)).toEqual({ payload, claims: { iat: 1_000, exp: 94_600 } });
  });

  it('rejects a tampered body, a tampered signature and another secret', () => {
    const token = signToken(payload, SECRET, { iat: 1, exp: 2 });
    const [, sig] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...payload, iat: 1, exp: 9_999_999_999 })).toString('base64url');
    expectInvalid(() => verifyToken(`${forgedBody}.${sig}`, SECRET));
    const flipped = sig.slice(0, -2) + (sig.endsWith('AA') ? 'AB' : 'AA');
    expectInvalid(() => verifyToken(`${token.split('.')[0]}.${flipped}`, SECRET));
    expectInvalid(() => verifyToken(token, 'b'.repeat(64)));
  });

  it('rejects malformed tokens, payloads of the wrong shape and malformed claims', () => {
    expectInvalid(() => verifyToken('garbage', SECRET));
    expectInvalid(() => verifyToken('a.b.c', SECRET));
    expectInvalid(() => verifyToken('.', SECRET));
    expectInvalid(() => verifyToken(signToken({ ...payload, v: 2 } as never, SECRET), SECRET));
    expectInvalid(() => verifyToken(signToken({ ...payload, res: [{ outcome: 'win' }] } as never, SECRET), SECRET));
    expectInvalid(() => verifyToken(signToken({ ...payload, exp: 5 } as never, SECRET), SECRET));
    expectInvalid(() => verifyToken(signToken(payload, SECRET, { iat: 1, exp: '2' as never }), SECRET));
  });
});
