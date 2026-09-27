import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestError } from '../../core/errors.js';
import type { RunPayload } from './buscaminas.types.js';

/** Seconds since the epoch. Unranked tokens carry them: past `exp` a token is dead even if Redis forgot its run. */
export interface TokenClaims {
  iat: number;
  exp: number;
}

export interface VerifiedToken {
  payload: RunPayload;
  claims: TokenClaims | null;
}

const mac = (body: string, secret: string): Buffer => createHmac('sha256', secret).update(body).digest();

export function signToken(payload: RunPayload, secret: string, claims?: TokenClaims): string {
  const body = Buffer.from(JSON.stringify(claims ? { ...payload, iat: claims.iat, exp: claims.exp } : payload)).toString('base64url');
  return `${body}.${mac(body, secret).toString('base64url')}`;
}

const invalid = (): BadRequestError => new BadRequestError('invalid_token', { reason: 'invalid_token' });

const isResult = (x: unknown): boolean => {
  const r = x as { outcome?: unknown; found?: unknown; points?: unknown } | null;
  return !!r && ['perfect', 'banked', 'mine'].includes(r.outcome as string) && Number.isInteger(r.found) && Number.isInteger(r.points);
};

export function verifyToken(token: string, secret: string): VerifiedToken {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) throw invalid();
  const given = Buffer.from(sig, 'base64url');
  const expected = mac(body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
  let parsed: RunPayload & Partial<TokenClaims>;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as RunPayload & Partial<TokenClaims>;
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object') throw invalid();
  const { iat, exp, ...p } = parsed;
  const ok = p.v === 1 && typeof p.rid === 'string' && typeof p.d === 'string' && Number.isInteger(p.cv)
    && (p.u === null || typeof p.u === 'string') && Number.isInteger(p.r) && Array.isArray(p.p)
    && (p.m === null || typeof p.m === 'string') && (p.s === null || isResult(p.s))
    && Array.isArray(p.res) && p.res.every(isResult) && typeof p.done === 'boolean' && Number.isInteger(p.sv);
  if (!ok) throw invalid();
  const hasClaims = iat !== undefined || exp !== undefined;
  if (hasClaims && !(Number.isInteger(iat) && Number.isInteger(exp))) throw invalid();
  return { payload: p, claims: hasClaims ? { iat: iat as number, exp: exp as number } : null };
}
