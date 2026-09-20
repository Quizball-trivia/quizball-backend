import { describe, expect, it } from 'vitest';
import { bucketIp, ipv6Prefix64 } from '../../src/core/ip-bucket.js';

describe('ip buckets', () => {
  it('keeps IPv4 and folds IPv6 to /64', () => {
    expect(bucketIp('203.0.113.9')).toBe('203.0.113.9');
    expect(bucketIp('2001:db8::1')).toBe(bucketIp('2001:db8::2'));
    expect(ipv6Prefix64('2001:db8:1:2:3:4:5:6')).toBe('2001:0db8:0001:0002');
    expect(bucketIp('::ffff:192.0.2.1')).toBe(bucketIp('::ffff:192.0.2.9'));
    expect(bucketIp(null)).toBe('unknown');
  });
});
