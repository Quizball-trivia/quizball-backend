import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { generateCampaignQuizImage } from '../../src/modules/campaign-quizzes/campaign-quiz-image-generation.service.js';

async function generatedWebp(): Promise<string> {
  const image = await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 3,
      background: '#2155ff',
    },
  }).webp().toBuffer();
  return image.toString('base64');
}

describe('campaign quiz image generation', () => {
  it('requests one square high-quality WebP and returns a preview data URL', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: 'gpt-image-2',
        n: 1,
        size: '1024x1024',
        quality: 'high',
        output_format: 'webp',
        background: 'opaque',
      });
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
      return new Response(JSON.stringify({ data: [{ b64_json: await generatedWebp() }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await generateCampaignQuizImage(
      { prompt: 'Create a square premium football illustration with a central original cannon.' },
      { apiKey: 'test-key', fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.data_url).toMatch(/^data:image\/webp;base64,/);
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not call the provider when the server key is missing', async () => {
    const fetchImpl = vi.fn();
    await expect(generateCampaignQuizImage(
      { prompt: 'Create a square premium football illustration with a central original cannon.' },
      { apiKey: '', fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toThrow(/not configured/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a useful retry message when the provider rate limits generation', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 429 }));
    await expect(generateCampaignQuizImage(
      { prompt: 'Create a square premium football illustration with a central original cannon.' },
      { apiKey: 'test-key', fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toThrow(/busy/);
  });

  it('maps malformed successful JSON to the provider response error', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>upstream failure</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }));

    await expect(generateCampaignQuizImage(
      { prompt: 'Create a square premium football illustration with a central original cannon.' },
      { apiKey: 'test-key', fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toThrow(/returned no artwork/);
  });

  it('rejects valid image bytes when the provider does not return WebP', async () => {
    const png = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: '#2155ff',
      },
    }).png().toBuffer();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: png.toString('base64') }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(generateCampaignQuizImage(
      { prompt: 'Create a square premium football illustration with a central original cannon.' },
      { apiKey: 'test-key', fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toThrow(/could not be processed/);
  });
});
