/** The two machine credentials: the source address allowlist and the x-api-key. */

import { timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { logger } from '../../core/logger.js';
import { sha256Hex, type PartnerConfig } from './partner-config.js';

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
