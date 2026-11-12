import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/config.js', () => ({
  config: { SUPABASE_URL: 'https://example.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'service-key' },
}));
vi.mock('../../src/core/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { buildShots } = await import('../../src/modules/hq/hq.media.js');

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => ({ signedURL: `/object/sign/hq-builds/${url.split('/hq-builds/')[1]}?token=t` }),
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('buildShots', () => {
  it('signs before and after screenshots with the service key', async () => {
    const out = await buildShots({
      at: '2026-11-12T10:00:00Z',
      before: [{ size: 'phone', path: 'builds/7/before-phone-abcdef12.png' }],
      after: [{ size: 'desktop', path: 'builds/7/after-desktop-abcdef12.png' }],
    });
    expect(out).toEqual({
      at: '2026-11-12T10:00:00Z',
      before: [{ size: 'phone', url: 'https://example.supabase.co/storage/v1/object/sign/hq-builds/builds/7/before-phone-abcdef12.png?token=t' }],
      after: [{ size: 'desktop', url: 'https://example.supabase.co/storage/v1/object/sign/hq-builds/builds/7/after-desktop-abcdef12.png?token=t' }],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.supabase.co/storage/v1/object/sign/hq-builds/builds/7/before-phone-abcdef12.png');
    expect(init.headers.Authorization).toBe('Bearer service-key');
  });

  it('never signs a path the Builder does not write (traversal, other buckets, wrong shape)', async () => {
    const out = await buildShots({
      after: [
        { size: 'phone', path: '../secrets/key.png' },
        { size: 'phone', path: 'builds/7/../../x.png' },
        { size: 'tablet', path: 'builds/7/after-phone-abcdef12.png' },
        { size: 'phone', path: 'builds/7/after-phone-abcdef12.jpg' },
      ],
    });
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves out a screenshot storage refuses, and returns null for nothing recorded', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    expect(await buildShots({ after: [{ size: 'phone', path: 'builds/8/after-phone-0123abcd.png' }] })).toBeNull();
    expect(await buildShots(null)).toBeNull();
    expect(await buildShots({})).toBeNull();
  });

  it('retries a screenshot whose signing failed, instead of hiding it until the cache expires', async () => {
    const shot = { after: [{ size: 'phone', path: 'builds/9/after-phone-0123abcd.png' }] };
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    expect(await buildShots(shot)).toBeNull();
    expect((await buildShots(shot))?.after).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
