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

export interface ClueTranslationInput {
  id: string;
  clue_1: string;
  clue_2: string;
  clue_3: string;
}

export interface ClueTranslationOutput {
  id: string;
  clue_1: string;
  clue_2: string;
  clue_3: string;
}

// ─── Provider ────────────────────────────────────────────────────────────────

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds for LLM requests

const QUESTION_SYSTEM_PROMPT = `You are a professional English to Georgian translator for a football quiz app.
Translate the following quiz questions from English to Georgian.
Return ONLY a valid JSON object with a single key "translations" containing an array of translated items.
Each item must have the same "id" as the input. Maintain array order for any translated string lists.
Use natural Georgian language appropriate for a quiz/trivia context.
Transliterate ALL proper nouns (player names, team names, tournament names) into Georgian script (e.g. "Liverpool" → "ლივერპული", "Messi" → "მესი", "Champions League" → "ჩემპიონთა ლიგა").`;

const CATEGORY_SYSTEM_PROMPT = `Translate these category names from English to Georgian.
Return ONLY a valid JSON object with a single key "translations" containing an array of {id, name} objects.
Transliterate proper nouns into Georgian script (e.g. "Premier League" → "პრემიერ ლიგა", "Bundesliga" → "ბუნდესლიგა").`;

const DIFFICULTY_SYSTEM_PROMPT = `You rate how hard it is for a knowledgeable football fan to GUESS THE PLAYER from a card of three clues.
Judge the player's overall fame and how identifying the clues are TAKEN TOGETHER — not the trickiness of a single clue.
- easy: an all-time great or current superstar most fans name immediately.
- medium: a well-known international or top-club player most engaged fans recognise, but not a household name.
- hard: a competent or specialist player, or clues built from non-signature facts, that even many fans would struggle to pin down.
Return ONLY JSON: {"difficulty":"easy|medium|hard"}. No prose.`;

const CLUE_SYSTEM_PROMPT = `You are a professional English to Georgian translator for a football auction guessing game.
Each item is a player's three first-person clues (clue_1, clue_2, clue_3) — the player describes their own career ("I am...", "I won...").
Translate all three clues from English to Georgian.
Return ONLY a valid JSON object with a single key "translations" containing an array of {id, clue_1, clue_2, clue_3} objects.
Each item must keep the same "id" as the input.
PRESERVE the first-person voice — the player is still speaking about themselves.
Do NOT reveal or add the player's name; the clues are a guessing puzzle.
Transliterate proper nouns (clubs, tournaments, countries) into Georgian script (e.g. "La Liga" → "ლა ლიგა", "Champions League" → "ჩემპიონთა ლიგა").`;

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
    const categoryContent = await this.chatCompletion(CATEGORY_SYSTEM_PROMPT, userMessage);
    return this.parseTranslationsArray<CategoryTranslationOutput>(
      categoryContent,
      categories.length
    );
  }

  async translateClues(batch: ClueTranslationInput[]): Promise<ClueTranslationOutput[]> {
    if (!this.apiKey) {
      throw new ExternalServiceError('OpenRouter API key not configured');
    }

    const payload = batch.map((c) => ({
      id: c.id,
      clue_1: c.clue_1,
      clue_2: c.clue_2,
      clue_3: c.clue_3,
    }));

    const userMessage = `Translate these clues to Georgian. Return JSON only:\n${JSON.stringify(payload)}`;
    const content = await this.chatCompletion(CLUE_SYSTEM_PROMPT, userMessage);
    return this.parseTranslationsArray<ClueTranslationOutput>(content, batch.length);
  }

  /**
   * Rate how hard the PLAYER is to guess from their three clues taken together
   * (player fame + how identifying the clues are), not the trickiness of one
   * clue. Returns 'easy' | 'medium' | 'hard'; falls back to 'medium' on any
   * parse/transport failure so import never blocks on the rater.
   */
  async rateDifficulty(clues: [string, string, string]): Promise<'easy' | 'medium' | 'hard'> {
    if (!this.apiKey) return 'medium';
    try {
      const userMessage = `Rate the difficulty of guessing the player. Return JSON only:\n${JSON.stringify(
        { clues }
      )}`;
      const content = await this.chatCompletion(DIFFICULTY_SYSTEM_PROMPT, userMessage);
      const cleaned = content.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const match = cleaned.match(/\b(easy|medium|hard)\b/i);
      const value = match?.[1]?.toLowerCase();
      if (value === 'easy' || value === 'medium' || value === 'hard') return value;
      return 'medium';
    } catch (error) {
      logger.warn({ error }, 'Difficulty rating failed; defaulting to medium');
      return 'medium';
    }
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
      max_tokens: 8000, // enough for a 20-item batch; without it the response truncated mid-JSON and the batch failed to parse
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
