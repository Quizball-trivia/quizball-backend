import { describe, expect, it } from 'vitest';
import { ipv6Prefix64 } from '../../src/http/routes/guest.routes.js';

describe('ipv6Prefix64', () => {
  it('buckets compressed and expanded forms of one /64 together', () => {
    expect(ipv6Prefix64('2001:db8::1')).toBe('2001:0db8:0000:0000');
    expect(ipv6Prefix64('2001:db8::2')).toBe(ipv6Prefix64('2001:0db8:0000:0000:0000:0000:0000:0002'));
    expect(ipv6Prefix64('2001:db8:1:2::9')).toBe('2001:0db8:0001:0002');
  });
  it('treats an embedded IPv4 tail as two hextets', () => {
    expect(ipv6Prefix64('2001:db8::1:2:3:192.0.2.1')).toBe(ipv6Prefix64('2001:db8:0:1:2:3:c000:201'));
    expect(ipv6Prefix64('64:ff9b::192.0.2.33')).toBe('0064:ff9b:0000:0000');
  });
  it('keeps different /64s apart', () => {
    expect(ipv6Prefix64('2001:db8:0:1::1')).not.toBe(ipv6Prefix64('2001:db8:0:2::1'));
    expect(ipv6Prefix64('::1')).toBe('0000:0000:0000:0000');
  });
});
