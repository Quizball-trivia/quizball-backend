import { config } from '../../core/config.js';
import { ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TranslationInput {
  id: string;
  prompt: string;
  options?: string[];
  explanation?: string;
}

export interface TranslationOutput {
  id: string;
  prompt: string;
  options?: string[];
  explanation?: string;
}

export interface CategoryTranslationInput {
  id: string;
  name: string;
}

export interface CategoryTranslationOutput {
  id: string;
  name: string;
}

// ─── Provider ────────────────────────────────────────────────────────────────

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds for LLM requests

const QUESTION_SYSTEM_PROMPT = `You are a professional English to Georgian translator for a football quiz app.
Translate the following quiz questions from English to Georgian.
Return ONLY a valid JSON object with a single key "translations" containing an array of translated items.
Each item must have the same "id" as the input. Maintain option array order.
Use natural Georgian language appropriate for a quiz/trivia context.
Transliterate ALL proper nouns (player names, team names, tournament names) into Georgian script (e.g. "Liverpool" → "ლივერპული", "Messi" → "მესი", "Champions League" → "ჩემპიონთა ლიგა").`;

const CATEGORY_SYSTEM_PROMPT = `Translate these category names from English to Georgian.
Return ONLY a valid JSON object with a single key "translations" containing an array of {id, name} objects.
Transliterate proper nouns into Georgian script (e.g. "Premier League" → "პრემიერ ლიგა", "Bundesliga" → "ბუნდესლიგა").`;

class OpenRouterTranslationProvider {
  private readonly apiKey: string | undefined;
  private readonly model: string;

  constructor() {
    this.apiKey = config.OPENROUTER_API_KEY;
    this.model = config.OPENROUTER_MODEL;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async translateQuestions(batch: TranslationInput[]): Promise<TranslationOutput[]> {
    if (!this.apiKey) {
      throw new ExternalServiceError('OpenRouter API key not configured');
    }

    const payload = batch.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      ...(q.options && { options: q.options }),
      ...(q.explanation && { explanation: q.explanation }),
    }));

    const userMessage = `Translate these to Georgian. Return JSON only:\n${JSON.stringify(payload)}`;
    const content = await this.chatCompletion(QUESTION_SYSTEM_PROMPT, userMessage);
    return this.parseTranslationsArray<TranslationOutput>(content, batch.length);
  }

  async translateCategories(
    categories: CategoryTranslationInput[]
  ): Promise<CategoryTranslationOutput[]> {
    if (!this.apiKey) {
      throw new ExternalServiceError('OpenRouter API key not configured');
    }

    const userMessage = `Translate these to Georgian. Return JSON only:\n${JSON.stringify(categories)}`;
    const content = await this.chatCompletion(CATEGORY_SYSTEM_PROMPT, userMessage);
    return this.parseTranslationsArray<CategoryTranslationOutput>(content, categories.length);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async chatCompletion(systemPrompt: string, userMessage: string): Promise<string> {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    };

    // Set up abort controller with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://quizball.app',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        logger.error({ status: response.status, error: errorText }, 'OpenRouter API error');
        throw new ExternalServiceError(`OpenRouter API error: ${response.status}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content ?? '';
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof ExternalServiceError) throw error;

      if (error instanceof Error && error.name === 'AbortError') {
        logger.error({ timeout: REQUEST_TIMEOUT_MS }, 'OpenRouter API request timed out');
        throw new ExternalServiceError('Translation request timed out');
      }

      logger.error({ error, model: this.model }, 'OpenRouter API request failed');
      throw new ExternalServiceError(
        `OpenRouter API request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        error
      );
    }
  }

  /**
   * Extract a translations array from LLM response text.
   * Handles markdown fences, wrapper objects like { "translations": [...] }.
   */
  private parseTranslationsArray<T>(content: string, expectedLength: number): T[] {
    let cleaned = content.trim();

    // Strip markdown code fences
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      logger.error({ content: cleaned.slice(0, 500) }, 'Failed to parse translation response');
      throw new ExternalServiceError('Invalid JSON in translation response');
    }

    // Unwrap wrapper object (e.g. { "translations": [...] })
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const values = Object.values(parsed as Record<string, unknown>);
      if (values.length === 1 && Array.isArray(values[0])) {
        parsed = values[0];
      }
    }

    if (!Array.isArray(parsed)) {
      throw new ExternalServiceError('Translation response is not an array');
    }

    if (parsed.length > expectedLength) {
      logger.warn(
        { expected: expectedLength, got: parsed.length },
        'Truncated extra translations from LLM response'
      );
      parsed.length = expectedLength;
    } else if (parsed.length < expectedLength) {
      throw new ExternalServiceError(
        `Translation count mismatch: expected ${expectedLength}, got ${parsed.length}`
      );
    }

    return parsed as T[];
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let instance: OpenRouterTranslationProvider | null = null;

/**
 * Test-only helper to reset provider singleton state between test cases.
 */
export function resetInstance(): void {
  instance = null;
}

export function getTranslationProvider(): OpenRouterTranslationProvider {
  if (!instance) {
    instance = new OpenRouterTranslationProvider();
  }
  return instance;
}
