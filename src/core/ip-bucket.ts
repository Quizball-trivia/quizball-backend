/** First four hextets of an expanded IPv6 address, so `2001:db8::1` and `2001:db8::2` share a bucket. */
export function ipv6Prefix64(ip: string): string {
  // Embedded IPv4 tail (::ffff:192.0.2.1 style) counts as two hextets.
  const dotted = ip.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    ip = ip.slice(0, -dotted[0].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...Array<string>(ip.includes('::') ? missing : 0).fill('0'), ...right];
  return groups.slice(0, 4).map((g) => g.padStart(4, '0').toLowerCase()).join(':');
}

/** IPv4 as-is, IPv6 by /64 — the unit every per-address budget is keyed on. */
export function bucketIp(ip: string | null | undefined): string {
  if (!ip) return 'unknown';
  return ip.includes(':') ? ipv6Prefix64(ip) : ip;
}
