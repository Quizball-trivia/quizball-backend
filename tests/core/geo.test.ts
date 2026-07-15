import { afterEach, describe, expect, it, vi } from 'vitest';
import { __geoTestHooks, detectCountryFromHeaders } from '../../src/core/geo.js';

describe('detectCountryFromHeaders', () => {
  afterEach(() => {
    __geoTestHooks.reset();
    vi.restoreAllMocks();
  });

  it('uses the Cloudflare country header when present', async () => {
    await expect(detectCountryFromHeaders({ 'cf-ipcountry': 'ge' }, '203.0.113.10')).resolves.toBe('GE');
  });

  it('uses accept-language as a localhost fallback', async () => {
    await expect(detectCountryFromHeaders({ 'accept-language': 'en-MA,en;q=0.9' }, '127.0.0.1')).resolves.toBe('MA');
  });

  it('uses the forwarded client IP before the socket IP fallback', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', country: 'Georgia', countryCode: 'GE' }),
    } as Response);

    await expect(
      detectCountryFromHeaders({ 'x-forwarded-for': '198.51.100.10, 10.0.0.1' }, '127.0.0.1')
    ).resolves.toBe('GE');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://ip-api.com/json/198.51.100.10?fields=status,country,countryCode',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('coalesces concurrent lookups and caches a successful country', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', country: 'Georgia', countryCode: 'GE' }),
    } as Response);

    await expect(Promise.all([
      detectCountryFromHeaders({}, '198.51.100.20'),
      detectCountryFromHeaders({}, '198.51.100.20'),
    ])).resolves.toEqual(['GE', 'GE']);
    await expect(detectCountryFromHeaders({}, '198.51.100.20')).resolves.toBe('GE');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('negative-caches failed lookups instead of retrying every auth request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
    } as Response);

    await expect(detectCountryFromHeaders({}, '198.51.100.30')).resolves.toBeNull();
    await expect(detectCountryFromHeaders({}, '198.51.100.30')).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
