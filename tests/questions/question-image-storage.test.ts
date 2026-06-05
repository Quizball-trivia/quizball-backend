import { afterEach, describe, expect, it, vi } from 'vitest';

import { BadRequestError } from '../../src/core/errors.js';
import { storeQuestionPayloadImages } from '../../src/modules/questions/question-image-storage.service.js';

const storageTarget = {
  supabaseUrl: 'https://storage.example.supabase.co',
  serviceRoleKey: 'service-role-key',
  label: 'test',
};

const basePayload = {
  type: 'mcq_single',
  image: {
    url: 'https://upload.wikimedia.org/example.png',
    width: 1440,
    height: 1080,
    aspect_ratio: '4:3',
    provider: 'bulk_upload',
  },
  options: [
    { id: 'A', text: { en: 'A' }, is_correct: true },
    { id: 'B', text: { en: 'B' }, is_correct: false },
    { id: 'C', text: { en: 'C' }, is_correct: false },
    { id: 'D', text: { en: 'D' }, is_correct: false },
  ],
};

describe('question image storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the original URL when source image download is rate limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));

    const stored = await storeQuestionPayloadImages(basePayload, {
      categorySlug: 'world-cup',
      target: storageTarget,
    }) as typeof basePayload & {
      image: typeof basePayload.image & {
        source_url: string;
        storage_status: string;
        storage_error: string;
        storage_attempted_at: string;
      };
    };

    expect(stored.image.url).toBe(basePayload.image.url);
    expect(stored.image.source_url).toBe(basePayload.image.url);
    expect(stored.image.storage_status).toBe('external_fallback');
    expect(stored.image.storage_error).toContain('429');
    expect(stored.image.storage_attempted_at).toEqual(expect.any(String));
  });

  it('rejects webpage URLs instead of saving them as image fallbacks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })));

    await expect(storeQuestionPayloadImages(basePayload, {
      categorySlug: 'world-cup',
      target: storageTarget,
    })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('does not fall back to webpage-looking URLs even when the source is rate limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));

    await expect(storeQuestionPayloadImages({
      ...basePayload,
      image: {
        ...basePayload.image,
        url: 'https://www.gettyimages.com/detail/news-photo/example',
      },
    }, {
      categorySlug: 'world-cup',
      target: storageTarget,
    })).rejects.toThrow('Image download failed: 429');
  });
});
