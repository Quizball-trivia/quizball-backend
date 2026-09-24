/**
 * Address policy for the WL content image probe: only public internet hosts
 * may be fetched. IPv4-mapped IPv6 ("::ffff:7f00:1") is matched against the
 * IPv4 rules by node's BlockList, which is why this is not a hand-rolled
 * prefix check.
 */
import { BlockList, isIP } from 'node:net';

const PRIVATE_NETS = new BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) {
  PRIVATE_NETS.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
] as const) {
  PRIVATE_NETS.addSubnet(addr, prefix, 'ipv6');
}

/** True for loopback, private, link-local, multicast, documentation and unspecified addresses — and for anything that is not an IP. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return PRIVATE_NETS.check(ip, 'ipv4');
  if (family === 6) return PRIVATE_NETS.check(ip, 'ipv6');
  return true;
}

export function isForbiddenHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === '';
}
