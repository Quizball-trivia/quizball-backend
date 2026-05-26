import { ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import {
  getTranslationProvider,
  type TranslationDomain,
  type TranslationItem,
} from './translation.provider.js';

export interface TranslateServiceInput {
  items: TranslationItem[];
  targetLocale: string;
  sourceLocale?: string;
  domain: TranslationDomain;
}

export const translationService = {
  async translate(input: TranslateServiceInput): Promise<TranslationItem[]> {
    const provider = getTranslationProvider();
    if (!provider.isConfigured()) {
      throw new ExternalServiceError('Translation provider not configured');
    }

    const started = Date.now();
    const translations = await provider.translate({
      items: input.items,
      targetLocale: input.targetLocale,
      sourceLocale: input.sourceLocale,
      domain: input.domain,
    });
    logger.info(
      {
        count: translations.length,
        targetLocale: input.targetLocale,
        domain: input.domain,
        durationMs: Date.now() - started,
      },
      'Translated batch',
    );
    return translations;
  },
};
