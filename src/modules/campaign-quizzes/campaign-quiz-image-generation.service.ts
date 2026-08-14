import sharp from 'sharp';
import { config } from '../../core/config.js';
import { ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

const OPENAI_IMAGE_GENERATION_URL = 'https://api.openai.com/v1/images/generations';
const REQUEST_TIMEOUT_MS = 150_000;
const MAX_GENERATED_IMAGE_BYTES = 12 * 1024 * 1024;

interface OpenAiImageGenerationResponse {
  data?: Array<{
    b64_json?: string;
  }>;
}

export interface CampaignQuizGeneratedImage {
  data_url: string;
  prompt: string;
  model: string;
  quality: 'low' | 'medium' | 'high';
  width: number;
  height: number;
}

interface GenerationDependencies {
  apiKey?: string;
  model?: string;
  quality?: 'low' | 'medium' | 'high';
  fetchImpl?: typeof fetch;
}

function providerError(status: number): ExternalServiceError {
  if (status === 401 || status === 403) {
    return new ExternalServiceError('Image generation is not configured correctly');
  }
  if (status === 429) {
    return new ExternalServiceError('Image generation is busy. Please wait a moment and try again.');
  }
  return new ExternalServiceError('Image generation failed. Please try again.');
}

export async function generateCampaignQuizImage(
  input: { prompt: string },
  dependencies: GenerationDependencies = {},
): Promise<CampaignQuizGeneratedImage> {
  const apiKey = dependencies.apiKey ?? config.OPENAI_API_KEY;
  const model = dependencies.model ?? config.OPENAI_IMAGE_MODEL;
  const quality = dependencies.quality ?? config.OPENAI_IMAGE_QUALITY;
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  if (!apiKey) {
    throw new ExternalServiceError(
      'Image generation is not configured. You can still upload artwork manually.',
    );
  }

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(OPENAI_IMAGE_GENERATION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        n: 1,
        size: '1024x1024',
        quality,
        output_format: 'webp',
        output_compression: 86,
        background: 'opaque',
        moderation: 'auto',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logger.error({ error, model, durationMs: Date.now() - startedAt }, 'Campaign artwork generation request failed');
    throw new ExternalServiceError('Image generation could not be reached. Please try again.');
  }

  if (!response.ok) {
    const providerRequestId = response.headers.get('x-request-id');
    logger.warn(
      { status: response.status, providerRequestId, model, durationMs: Date.now() - startedAt },
      'Campaign artwork generation rejected',
    );
    throw providerError(response.status);
  }

  const payload = await response.json() as OpenAiImageGenerationResponse;
  const encoded = payload.data?.[0]?.b64_json;
  if (!encoded) {
    logger.error({ model, durationMs: Date.now() - startedAt }, 'Campaign artwork generation returned no image');
    throw new ExternalServiceError('Image generation returned no artwork. Please try again.');
  }

  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new ExternalServiceError('Generated artwork could not be processed');
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  } catch (error) {
    logger.error({ error, model }, 'Campaign artwork generation returned invalid image bytes');
    throw new ExternalServiceError('Generated artwork could not be processed');
  }
  if (!metadata.width || !metadata.height) {
    throw new ExternalServiceError('Generated artwork could not be processed');
  }

  logger.info(
    {
      model,
      quality,
      width: metadata.width,
      height: metadata.height,
      bytes: buffer.length,
      durationMs: Date.now() - startedAt,
    },
    'Campaign artwork generation completed',
  );

  return {
    data_url: `data:image/webp;base64,${encoded}`,
    prompt: input.prompt,
    model,
    quality,
    width: metadata.width,
    height: metadata.height,
  };
}

export const campaignQuizImageGenerationService = {
  generate: generateCampaignQuizImage,
};
