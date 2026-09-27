import type { RedisClientType } from 'redis';
import { logger } from '../../core/logger.js';
import { getRedisClient } from '../../realtime/redis.js';
import { RUN_TOKEN_TTL_SECONDS } from './buscaminas.constants.js';
import { unavailable } from './buscaminas.errors.js';

/**
 * Single-use tokens for UNRANKED runs (ranked runs are guarded by their database
 * row). One small hash per run id holds the last consumed state version, the
 * fingerprint of the action that consumed it and the issue time of the token it
 * returned: a network retry of the same action rebuilds the identical response,
 * any other use of a consumed token is stale. Without this a stateless token
 * could be replayed to probe every card of a round. Tokens expire with their
 * ledger entry, so an evicted entry cannot revive a token past its lifetime.
 */
export type LedgerVerdict = { kind: 'fresh' } | { kind: 'stale' } | { kind: 'replay'; iat: number };

export interface RunLedger {
  /** Atomically consume `sv` of run `rid` for this action; a lost race reports the winner's verdict. */
  claim(rid: string, sv: number, fingerprint: string, iat: number): Promise<LedgerVerdict>;
  /** Read-only: has `sv` of run `rid` already been consumed? Consulted only when a move is invalid, so a stale token reports stale. */
  consumed(rid: string, sv: number): Promise<boolean>;
}

/** Shared (all replicas) counter of live-day unranked starts, keyed by Buenos Aires day and address bucket. */
export interface StartCounter {
  hit(key: string): Promise<number>;
}

const COMMAND_TIMEOUT_MS = 2_000;
const START_COUNTER_TTL_SECONDS = 26 * 3600;

const CLAIM = `local cur = redis.call('HMGET', KEYS[1], 'sv', 'fp', 'iat')
local sv = tonumber(ARGV[1])
if cur[1] then
  local s = tonumber(cur[1])
  if s == sv and cur[2] == ARGV[2] and cur[3] then return {'replay', cur[3]} end
  if s >= sv then return {'stale'} end
end
redis.call('HSET', KEYS[1], 'sv', ARGV[1], 'fp', ARGV[2], 'iat', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return {'fresh'}`;

const HIT = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;

/** Any Redis failure — not connected, a rejected command or a stall — is a 503, never a raw error or a "database" message. */
async function withRedis<T>(fn: (redis: RedisClientType) => Promise<T>): Promise<T> {
  const redis = getRedisClient();
  if (!redis?.isReady) throw unavailable();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(redis),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Redis command exceeded ${COMMAND_TIMEOUT_MS}ms`)), COMMAND_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn({ err: error }, 'Buscaminas Redis command failed');
    throw unavailable();
  } finally {
    clearTimeout(timer);
  }
}

/** A reply outside the script's protocol is a Redis fault (503), never a verdict. */
const verdict = (raw: unknown): LedgerVerdict => {
  const [kind, iat] = Array.isArray(raw) ? (raw as [unknown, unknown?]) : [];
  if (kind === 'fresh' || kind === 'stale') return { kind };
  if (kind === 'replay' && Number.isSafeInteger(Number(iat))) return { kind, iat: Number(iat) };
  throw new Error('Unexpected run ledger reply');
};

const runKey = (rid: string) => `buscaminas:run:${rid}`;

export const redisRunLedger: RunLedger = {
  claim: (rid, sv, fingerprint, iat) => withRedis(async (redis) => verdict(await redis.eval(CLAIM, {
    keys: [runKey(rid)],
    arguments: [String(sv), fingerprint, String(iat), String(RUN_TOKEN_TTL_SECONDS)],
  }))),
  consumed: (rid, sv) => withRedis(async (redis) => {
    const last = await redis.hGet(runKey(rid), 'sv');
    if (last === undefined || last === null) return false;
    if (!Number.isSafeInteger(Number(last))) throw new Error('Unexpected run ledger reply');
    return Number(last) >= sv;
  }),
};

export const redisStartCounter: StartCounter = {
  hit: (key) => withRedis(async (redis) => {
    const count = Number(await redis.eval(HIT, { keys: [`buscaminas:live-starts:${key}`], arguments: [String(START_COUNTER_TTL_SECONDS)] }));
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid start counter response');
    return count;
  }),
};

/** Same semantics in process memory, for tests. */
export function memoryRunLedger(): RunLedger {
  const runs = new Map<string, { sv: number; fp: string; iat: number }>();
  return {
    async claim(rid, sv, fp, iat) {
      const cur = runs.get(rid);
      if (cur && cur.sv === sv && cur.fp === fp) return { kind: 'replay', iat: cur.iat };
      if (cur && cur.sv >= sv) return { kind: 'stale' };
      runs.set(rid, { sv, fp, iat });
      return { kind: 'fresh' };
    },
    async consumed(rid, sv) {
      const cur = runs.get(rid);
      return cur !== undefined && cur.sv >= sv;
    },
  };
}

export function memoryStartCounter(): StartCounter & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async hit(key) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
}
