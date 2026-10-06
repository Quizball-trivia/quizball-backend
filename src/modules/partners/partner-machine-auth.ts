/** Machine class (partner's server → us): source IP allowlist first, then the x-api-key, then a per-key rate limit.
 *  A refused caller never reaches a handler. */

import { timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../../core/logger.js';
import type { RedisClientType } from 'redis';
import { resolveTrustedClientIp } from '../../http/client-ip.js';
import { getRedisClient } from '../../realtime/redis.js';
import { getFreecrocoConfig, sha256Hex, type PartnerConfig } from './partner-config.js';
import { PartnerError, sendPartnerError } from './partner-errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The partner a machine request authenticated as (set by partnerMachineAuth). */
      partnerMachine?: { config: PartnerConfig; keyHash: string };
    }
  }
}

/** The deploy's partner config, or a 503: a deploy without it serves no partner routes. */
export function requirePartnerConfig(): PartnerConfig {
  let config: PartnerConfig | null;
  try {
    config = getFreecrocoConfig();
  } catch (error) {
    // A malformed secret is our fault, never the caller's invalid_request. The parser's message can quote the
    // input (keys), so only a fixed code and the schema paths are logged.
    const issues = error instanceof ZodError ? error.issues.map((i) => `${i.path.join('.') || '(root)'}:${i.code}`) : ['json'];
    logger.error({ code: 'partner_config_invalid', issues }, 'PARTNER_FREECROCO_CONFIG is invalid');
    throw new PartnerError('maintenance', undefined, 60);
  }
  if (!config) throw new PartnerError('maintenance', 'Partner integration is not configured', 60);
  return config;
}

const allowLists = new WeakMap<PartnerConfig, (ip: string | undefined) => boolean>();

/** Exactly `address` or `address/prefix`; anything else allows nothing (a lenient parse once read `a.b.c.d/` as /0). */
function addBlock(list: BlockList, value: string): boolean {
  const match = /^([0-9A-Fa-f.:]+)(?:\/(0|[1-9][0-9]{0,2}))?$/.exec(value);
  if (!match) return false;
  const family = isIP(match[1]);
  if (!family) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (match[2] === undefined) {
    list.addAddress(match[1], type);
    return true;
  }
  const prefix = Number(match[2]);
  if (prefix > (family === 4 ? 32 : 128)) return false;
  list.addSubnet(match[1], prefix, type);
  return true;
}

export function ipAllowed(config: PartnerConfig, ip: string | undefined): boolean {
  let check = allowLists.get(config);
  if (!check) {
    const list = new BlockList();
    for (const cidr of config.allowedCidrs) {
      if (!addBlock(list, cidr)) logger.error({ cidr }, 'Partner allowlist entry is not an IP or CIDR; ignored');
    }
    check = (address) => {
      if (!address) return false;
      const family = isIP(address);
      return family !== 0 && list.check(address, family === 6 ? 'ipv6' : 'ipv4');
    };
    allowLists.set(config, check);
  }
  return check(ip);
}

/** The configured key hash the presented key matches, compared in constant time against every configured key. */
export function matchApiKey(config: PartnerConfig, presented: unknown): string | null {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 512) return null;
  const candidate = Buffer.from(sha256Hex(presented), 'hex');
  let matched: string | null = null;
  for (const hash of config.inboundKeySha256) {
    if (timingSafeEqual(candidate, Buffer.from(hash, 'hex')) && matched === null) matched = hash;
  }
  return matched;
}

/** Contract §2: 50 requests per second per key, bursts up to 100. */
export const MACHINE_RATE_PER_SECOND = 50;
export const MACHINE_BURST = 100;
const REDIS_DEADLINE_MS = 100;

/** One token bucket per key for the whole deployment, on Redis's clock (replicas' clocks never matter). The stored
 *  timestamp only moves forward: after a backward clock step nothing refills until Redis time passes it again, and
 *  the key lives that much longer. Returns {allowed (1|0), retry after ms}. */
export const TOKEN_BUCKET_SCRIPT = `
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(state[1]) or burst
local at = tonumber(state[2]) or now
tokens = math.min(burst, tokens + math.max(0, now - at) * rate / 1000)
local stored = math.max(at, now)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  -- Refill only starts once Redis time passes the stored timestamp.
  retry = math.ceil((1 - tokens) * 1000 / rate) + (stored - now)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', tostring(stored))
redis.call('PEXPIRE', KEYS[1], math.ceil(burst * 1000 / rate) + 1000 + (stored - now))
return {allowed, retry}
`;

export interface BucketStore {
  /** [allowed, retryAfterMs], or throws when the store is unavailable. */
  take(key: string, ratePerSecond: number, burst: number): Promise<[boolean, number]>;
}

export function redisBucketStore(getClient: () => RedisClientType | null = getRedisClient): BucketStore {
  return {
    async take(key, ratePerSecond, burst) {
      const client = getClient();
      if (!client?.isReady) throw new Error('redis is not connected');
      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          client.eval(TOKEN_BUCKET_SCRIPT, { keys: [key], arguments: [String(ratePerSecond), String(burst)] }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`redis took over ${REDIS_DEADLINE_MS} ms`)), REDIS_DEADLINE_MS);
          }),
        ]);
        const [allowed, retry] = result as [number, number];
        return [allowed === 1, Number(retry)];
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Per-process bucket. Every request must pass it as well as the shared one, so neither losing Redis nor getting it
 * back hands out a second burst. Monotonic clock: a wall-clock step never refills it.
 */
export function localBucketStore(now: () => number = () => performance.now()): BucketStore {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const refill = (key: string, ratePerSecond: number, burst: number) => {
    const t = now();
    const bucket = buckets.get(key) ?? { tokens: burst, at: t };
    bucket.tokens = Math.min(burst, bucket.tokens + (Math.max(0, t - bucket.at) / 1000) * ratePerSecond);
    bucket.at = Math.max(bucket.at, t);
    buckets.set(key, bucket);
    return bucket;
  };
  return {
    async take(key, ratePerSecond, burst) {
      const bucket = refill(key, ratePerSecond, burst);
      if (bucket.tokens < 1) return [false, Math.ceil(((1 - bucket.tokens) * 1000) / ratePerSecond)];
      bucket.tokens -= 1;
      return [true, 0];
    },
  };
}

const WARN_EVERY_MS = 60_000;

/**
 * Rate limit per API key across the deployment (Redis) and per process: a request needs both. When Redis is
 * unavailable the per-process bucket alone decides and a warning is logged at most once a minute: Freecroco is never
 * refused because of our Redis.
 */
export function machineRateLimiter(
  shared: BucketStore = redisBucketStore(),
  fallback: BucketStore = localBucketStore(),
  ratePerSecond = MACHINE_RATE_PER_SECOND,
  burst = MACHINE_BURST,
): RequestHandler {
  let lastWarnAt = 0;
  return async (req, res, next) => {
    const machine = req.partnerMachine;
    const key = `partner:rl:${machine?.config.slug ?? 'none'}:${machine?.config.environment ?? 'none'}:${machine?.keyHash.slice(0, 16) ?? 'none'}`;
    let sharedDecision: [boolean, number] = [true, 0];
    try {
      sharedDecision = await shared.take(key, ratePerSecond, burst);
    } catch (error) {
      if (Date.now() - lastWarnAt > WARN_EVERY_MS) {
        lastWarnAt = Date.now();
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Partner rate limit store unavailable; per-process fallback');
      }
    }
    // A refusal by the shared bucket costs no local token.
    const localDecision: [boolean, number] = sharedDecision[0] ? await fallback.take(key, ratePerSecond, burst) : [true, 0];
    const allowed = sharedDecision[0] && localDecision[0];
    const retryMs = Math.max(sharedDecision[1], localDecision[1]);
    if (!allowed) return sendPartnerError(res, new PartnerError('rate_limited', undefined, Math.max(1, Math.ceil(retryMs / 1000))));
    next();
  };
}

function authenticateMachine(req: Request, _res: Response, next: NextFunction): void {
  const config = requirePartnerConfig();
  const ip = resolveTrustedClientIp(req);
  if (!ipAllowed(config, ip)) {
    logger.warn({ reason: 'ip_not_allowed', ip, path: req.path }, 'Partner machine request refused');
    throw new PartnerError('ip_not_allowed');
  }
  const keyHash = matchApiKey(config, req.headers['x-api-key']);
  if (!keyHash) {
    logger.warn({ reason: 'unknown_key', ip, path: req.path }, 'Partner machine request refused');
    throw new PartnerError('unknown_key');
  }
  req.partnerMachine = { config, keyHash };
  next();
}

const machineLimiter = machineRateLimiter();

export const partnerMachineAuth: RequestHandler[] = [authenticateMachine, machineLimiter];
