import { config } from '../../core/config.js';
import { ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

export type TranslationDomain = 'general' | 'legal' | 'marketing' | 'ui';

export interface TranslationItem {
  id: string;
  text: string;
}

export interface TranslateRequest {
  items: TranslationItem[];
  targetLocale: string;
  sourceLocale?: string;
  domain: TranslationDomain;
}

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 60_000;

const LOCALE_LABELS: Record<string, string> = {
  en: 'English',
  ka: 'Georgian',
};

function labelFor(locale: string): string {
  return LOCALE_LABELS[locale] ?? locale;
}

// Domain-specific guidance layered on top of a neutral base prompt. Avoids the
// football-quiz transliteration bias of the existing question translator so
// generic marketing, legal, and UI strings stay accurate.
function systemPromptFor(domain: TranslationDomain, source: string, target: string): string {
  const base = `You are a professional translator from ${labelFor(source)} to ${labelFor(target)}.
Translate each item's "text" field accurately. Preserve meaning, tone, punctuation, line breaks, markdown, and any inline formatting.
Return ONLY a valid JSON object with a single key "translations" containing an array of {id, text} objects in the same order as the input.
Every input id must appear exactly once in the output.
Do not add commentary, explanations, or wrap output in markdown fences.`;

  switch (domain) {
    case 'legal':
      return `${base}
This is legal text (terms of service, privacy policy, etc.). Translate established legal terms using the standard ${labelFor(target)} legal vocabulary. Do not transliterate legal terminology phonetically. Keep section numbering and structure intact.`;
    case 'marketing':
      return `${base}
This is marketing copy. Prioritize natural, engaging ${labelFor(target)} that reads like it was written natively. Brand names (e.g. "QuizBall") must remain unchanged in Latin script.`;
    case 'ui':
      return `${base}
This is short UI microcopy (button labels, menu items, error messages). Keep translations concise and idiomatic. Match the brevity of the source.`;
    case 'general':
    default:
      return `${base}
Brand names and proper nouns of products should remain in their original script unless they have an established target-language equivalent.`;
  }
}

class GenericTranslationProvider {
  private readonly apiKey: string | undefined;
  private readonly model: string;

  constructor() {
    this.apiKey = config.OPENROUTER_API_KEY;
    this.model = config.OPENROUTER_MODEL;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async translate(req: TranslateRequest): Promise<TranslationItem[]> {
    if (!this.apiKey) {
      throw new ExternalServiceError('OpenRouter API key not configured');
    }
    if (req.items.length === 0) {
      return [];
    }

    const source = req.sourceLocale ?? 'en';
    const systemPrompt = systemPromptFor(req.domain, source, req.targetLocale);
    const userMessage = `Translate to ${labelFor(req.targetLocale)} (${req.targetLocale}). Return JSON only:\n${JSON.stringify(req.items)}`;

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://quizball.io',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Don't log the raw body — upstream may echo prompts, API keys, or
        // PII. Capture only safe metadata for diagnostics.
        const bodyText = await response.text().catch(() => '');
        logger.error(
          {
            status: response.status,
            requestId: response.headers.get('x-request-id') ?? response.headers.get('cf-ray'),
            bodyLength: bodyText.length,
          },
          'OpenRouter API error',
        );
        throw new ExternalServiceError(`OpenRouter API error: ${response.status}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      return this.parseResponse(content, req.items);
    } catch (err) {
      if (err instanceof ExternalServiceError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        logger.error({ timeout: REQUEST_TIMEOUT_MS }, 'OpenRouter translate timed out');
        throw new ExternalServiceError('Translation request timed out');
      }
      // Log only error name/message — `err` itself can include response
      // bodies attached by fetch wrappers or stack traces with user content.
      logger.error(
        {
          model: this.model,
          errName: err instanceof Error ? err.name : 'unknown',
          errMessage: err instanceof Error ? err.message : 'unknown',
        },
        'OpenRouter translate failed',
      );
      throw new ExternalServiceError(
        `OpenRouter translate failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        err,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseResponse(content: string, inputs: TranslationItem[]): TranslationItem[] {
    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Don't log the model's raw output — could contain user text.
      logger.error({ length: cleaned.length }, 'Failed to parse translate response');
      throw new ExternalServiceError('Invalid JSON in translation response');
    }

    let array: unknown = parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const values = Object.values(parsed as Record<string, unknown>);
      if (values.length === 1 && Array.isArray(values[0])) {
        array = values[0];
      }
    }

    if (!Array.isArray(array)) {
      throw new ExternalServiceError('Translation response is not an array');
    }

    const byId = new Map<string, string>();
    for (const entry of array) {
      if (
        entry
        && typeof entry === 'object'
        && 'id' in entry
        && 'text' in entry
        && typeof (entry as { id: unknown }).id === 'string'
        && typeof (entry as { text: unknown }).text === 'string'
      ) {
        const { id, text } = entry as { id: string; text: string };
        byId.set(id, text);
      }
    }

    const ordered: TranslationItem[] = [];
    for (const input of inputs) {
      const text = byId.get(input.id);
      if (text === undefined) {
        throw new ExternalServiceError(`Missing translation for id "${input.id}"`);
      }
      ordered.push({ id: input.id, text });
    }
    return ordered;
  }
}

let instance: GenericTranslationProvider | null = null;

export function resetTranslationProvider(): void {
  instance = null;
}

export function getTranslationProvider(): GenericTranslationProvider {
  if (!instance) {
    instance = new GenericTranslationProvider();
  }
  return instance;
}
